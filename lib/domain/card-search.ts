import { or, like, eq, and, sql, inArray, type SQL } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, priceCache, type Card, type PriceCache } from '@/lib/db/schema'
import { type Game, type Language } from '@/lib/games'
import { searchPokemonCards, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { getSettings } from '@/lib/settings'
import { usdToGbp } from '@/lib/pricing'
import { syncMarketPricesForCard, refreshStaleCardmarket } from '@/lib/prices/sync'
import { normalizeName, similarity } from '@/lib/fuzzy'

// Catalogue searches return up to 100 rows — enough for every printing of a
// single name (Snorlax has 57) without paginating. The live-API price lookup
// (/api/prices/search) keeps its own cap of 30: it's a research tool whose
// every result fans out into per-variant price fetches, and the upstream API
// gets slow at larger page sizes.
export const CARD_SEARCH_LIMIT = 100

// Dice-over-trigrams score a candidate name must reach before we suggest it
// for a misspelling. 0.4 lets one-letter typos through ("snorlex" → "snorlax"
// ≈ 0.6) while unrelated names stay near 0.
export const FUZZY_THRESHOLD = 0.4
const FUZZY_MAX_NAMES = 5

export interface CardSearchResult {
  cards: Card[]
  // priceCache rows keyed by card id, so callers render prices without an
  // extra request per card.
  prices: Record<number, PriceCache>
  // True when the results are close-name suggestions rather than literal matches.
  fuzzy: boolean
  // True when nothing matched locally AND the live-API fallback failed
  // (timeout, network, upstream error) — "try again" rather than "no such card".
  unavailable: boolean
}

interface SearchDeps {
  fetchLive?: (q: string) => Promise<PokemonTCGCard[]>
  syncMarketPrices?: typeof syncMarketPricesForCard
  // Test seam for the fuzzy name cache's TTL.
  now?: number
}

export interface CardSearchFilters {
  game?: Game
  language?: Language
}

// Local catalogue first (instant, works offline), then fuzzy name suggestions
// for misspellings, then the live API for cards newer than the last catalogue
// sweep. The live call is time-bounded upstream, so a hung upstream becomes a
// fast `unavailable` result instead of a stuck request. Optional filters scope
// every stage to one game and/or language.
export async function searchCards(
  q: string,
  dbc: Db = db,
  deps: SearchDeps = {},
  filters: CardSearchFilters = {},
): Promise<CardSearchResult> {
  const fetchLive = deps.fetchLive ?? searchPokemonCards
  const syncMarketPrices = deps.syncMarketPrices ?? syncMarketPricesForCard

  const scope = [
    ...(filters.game ? [eq(cards.game, filters.game)] : []),
    ...(filters.language ? [eq(cards.language, filters.language)] : []),
  ]

  // Ranked: exact name, then name prefix, then substring/alias/set-number
  // match. aliasName lets an EN species query find CJK printings.
  const likeMatches = await dbc.select().from(cards)
    .where(and(
      or(like(cards.name, `%${q}%`), like(cards.aliasName, `%${q}%`), like(cards.setNumber, `%${q}%`)),
      ...scope,
    ))
    .orderBy(
      sql`CASE WHEN lower(${cards.name}) = lower(${q}) THEN 0 WHEN ${cards.name} LIKE ${q + '%'} THEN 1 ELSE 2 END`,
      cards.name,
    )
    .limit(CARD_SEARCH_LIMIT)
  if (likeMatches.length > 0) {
    return { cards: likeMatches, prices: await pricesForFresh(likeMatches, dbc, syncMarketPrices), fuzzy: false, unavailable: false }
  }

  const fuzzyMatches = await searchFuzzy(q, dbc, scope, deps.now ?? Date.now())
  if (fuzzyMatches.length > 0) {
    return { cards: fuzzyMatches, prices: await pricesForFresh(fuzzyMatches, dbc, syncMarketPrices), fuzzy: true, unavailable: false }
  }

  // pokemontcg.io is EN-only — inserting its cards into a non-EN-filtered
  // search would be wrong, so a scoped miss is just a miss.
  if (filters.language && filters.language !== 'EN') {
    return { cards: [], prices: {}, fuzzy: false, unavailable: false }
  }

  // Nothing local — fall back to the live API (e.g. a set newer than the
  // last catalogue sweep) and lazily insert what it finds.
  let apiCards: PokemonTCGCard[]
  try {
    apiCards = await fetchLive(q)
  } catch (e) {
    console.error('Live card search failed for', q, '→', e)
    return { cards: [], prices: {}, fuzzy: false, unavailable: true }
  }
  const settings = await getSettings(dbc)
  const newCards = (await Promise.all(
    apiCards.map(apiCard => insertCardSafely(apiCard, settings.highValueThreshold, settings.usdToGbp, settings.eurToGbp, dbc, syncMarketPrices))
  )).filter((c): c is Card => c != null)

  return { cards: newCards, prices: await pricesForFresh(newCards, dbc, syncMarketPrices), fuzzy: false, unavailable: false }
}

// Refresh missing/stale Cardmarket cache entries for the top results before
// pricing them: buy offers must come from the shop's primary source rather
// than silently from the TCGplayer USD fallback — the nightly in-stock sync
// never covers cards the shop hasn't stocked. Bounded and best-effort inside
// refreshStaleCardmarket, so a TCGdex outage cannot slow or break search.
async function pricesForFresh(
  rows: Card[], dbc: Db, sync: typeof syncMarketPricesForCard,
): Promise<Record<number, PriceCache>> {
  await refreshStaleCardmarket(rows, dbc, { sync })
  return pricesFor(rows, dbc)
}

async function pricesFor(rows: Card[], dbc: Db): Promise<Record<number, PriceCache>> {
  if (rows.length === 0) return {}
  const cached = await dbc.select().from(priceCache)
    .where(inArray(priceCache.cardId, rows.map(c => c.id)))
  return Object.fromEntries(cached.map(p => [p.cardId, p]))
}

// --- Fuzzy candidate retrieval ---------------------------------------------
// Primary path: the cards_fts FTS5 trigram index (migration 0025), kept in
// sync by triggers on `cards`. The query's trigrams OR-ed together retrieve
// every name sharing at least one trigram, bm25-ranked so the closest names
// surface first; that small candidate set is then re-scored with
// similarity(), so FUZZY_THRESHOLD semantics are identical to the full scan.
// The index tokenizes raw text (it sees the punctuation/spaces that
// normalizeName strips), so in principle a pair sharing only trigrams that
// span stripped characters can slip past retrieval — real card names are
// long enough that this doesn't bite, and the scorer still has the last word.

// Distinct (name, alias) groups to retrieve before re-scoring. Generous
// headroom over FUZZY_MAX_NAMES for bm25 and similarity() disagreeing about
// the ordering.
const FTS_CANDIDATE_LIMIT = 200
// Bounds MATCH cost for pathological input; 64 trigrams covers a ~66-char
// query, longer ones are matched on their prefix and re-scored in full.
const FTS_MAX_QUERY_TRIGRAMS = 64

function trigramMatchExpr(q: string): string {
  const s = q.toLowerCase()
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= s.length && grams.size < FTS_MAX_QUERY_TRIGRAMS; i++) grams.add(s.slice(i, i + 3))
  return [...grams].map(g => `"${g.replaceAll('"', '""')}"`).join(' OR ')
}

async function fuzzyCandidates(q: string, dbc: Db, now: number): Promise<CardNameRow[]> {
  // Below one trigram the scorer can only match by normalized equality
  // (e.g. "n." → the card "N"), which the index cannot retrieve — scan.
  if (normalizeName(q).length < 3) return distinctNames(dbc, now)
  try {
    return await dbc.all<CardNameRow>(sql`
      SELECT name, alias_name AS aliasName FROM cards_fts
      WHERE cards_fts MATCH ${trigramMatchExpr(q)} AND name IS NOT NULL
      GROUP BY name, alias_name ORDER BY min(rank) LIMIT ${FTS_CANDIDATE_LIMIT}`)
  } catch (e) {
    logFtsFallback(dbc, e)
    return distinctNames(dbc, now)
  }
}

// Fleet migrations run after deploys, so "no such table: cards_fts" is a
// routine (if temporary) tenant state — say so once per Db handle rather than
// on every fuzzy miss. Anything else is a real bug worth every occurrence.
const ftsFallbackLogged = new WeakSet<Db>()
function logFtsFallback(dbc: Db, e: unknown): void {
  const missingTable = e instanceof Error && e.message.includes('no such table')
  if (missingTable && ftsFallbackLogged.has(dbc)) return
  ftsFallbackLogged.add(dbc)
  console[missingTable ? 'warn' : 'error']('Fuzzy search fell back to the name scan:', e)
}

// --- Fallback: cached full-name scan ---------------------------------------
// Serves tenants whose DB predates migration 0025, and sub-trigram queries.
// The distinct name list is cached per Db handle for 10 minutes: at MTG scale
// (157k+ cards) the selectDistinct dominates every fuzzy miss (~12s measured),
// and the list only changes when the catalogue does. Keying the WeakMap by the
// Db handle keeps tenants isolated — handles are long-lived per tenant
// (lib/db `tenantDbs`), so entries survive across requests but a name list is
// never shared between tenants.
const NAME_CACHE_TTL_MS = 10 * 60_000
type CardNameRow = { name: string; aliasName: string | null }
const nameCaches = new WeakMap<Db, { names: CardNameRow[]; at: number }>()

// Fetched unscoped on purpose so one cache entry serves every game/language
// filter. Names outside the caller's scope can then enter fuzzy scoring, but
// the printings query in searchFuzzy stays scoped, so at worst an out-of-scope
// name wastes one of the FUZZY_MAX_NAMES suggestion slots.
async function distinctNames(dbc: Db, now: number): Promise<CardNameRow[]> {
  const hit = nameCaches.get(dbc)
  if (hit && now - hit.at < NAME_CACHE_TTL_MS) return hit.names
  const names = await dbc.selectDistinct({ name: cards.name, aliasName: cards.aliasName }).from(cards)
  nameCaches.set(dbc, { names, at: now })
  return names
}

// Retrieve candidate names (and EN aliases, for CJK rows), score them against
// the query with similarity(), then pull all printings of the closest few.
async function searchFuzzy(q: string, dbc: Db, scope: SQL[], now: number): Promise<Card[]> {
  const names = await fuzzyCandidates(q, dbc, now)
  const scores = new Map<string, number>()
  for (const { name, aliasName } of names) {
    const score = Math.max(similarity(q, name), aliasName ? similarity(q, aliasName) : 0)
    if (score >= FUZZY_THRESHOLD) scores.set(name, Math.max(score, scores.get(name) ?? 0))
  }
  if (scores.size === 0) return []

  const topNames = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FUZZY_MAX_NAMES)
    .map(([name]) => name)

  const rows = await dbc.select().from(cards)
    .where(and(inArray(cards.name, topNames), ...scope))
    .limit(CARD_SEARCH_LIMIT)
  return rows.sort((a, b) =>
    (scores.get(b.name)! - scores.get(a.name)!) || a.name.localeCompare(b.name) || a.setName.localeCompare(b.setName))
}

// Resilient insert: re-checks for an existing row (handles a race between
// concurrent searches) and swallows unique-constraint violations from a
// concurrent insert, returning whatever row ends up in the DB.
async function insertCardSafely(
  apiCard: PokemonTCGCard,
  threshold: number,
  rate: number,
  eurRate: number,
  dbc: Db,
  syncMarketPrices: typeof syncMarketPricesForCard,
): Promise<Card | null> {
  const [existing] = await dbc.select().from(cards).where(eq(cards.externalId, apiCard.id)).limit(1)
  if (existing) return existing

  try {
    const [card] = await dbc.insert(cards).values({
      name: apiCard.name,
      game: 'pokemon',
      setName: apiCard.set.name,
      setNumber: apiCard.number,
      variant: apiCard.subtypes?.join('/') ?? null,
      externalId: apiCard.id,
      imageUrl: apiCard.images.small,
      imageUrlLarge: apiCard.images.large,
    }).returning()

    if (card) {
      const p = extractBestPrice(apiCard) // USD from TCGplayer
      const market = usdToGbp(p.market, rate)
      try {
        await dbc.insert(priceCache).values({
          cardId: card.id,
          tcgplayerMarket: market,
          tcgplayerLow: usdToGbp(p.low, rate),
          tcgplayerMid: usdToGbp(p.mid, rate),
          tcgplayerHigh: usdToGbp(p.high, rate),
          isHighValue: (market ?? 0) >= threshold,
        })
        // Fire-and-forget: don't add a TCGdex round-trip to search latency.
        // Durable population is guaranteed by the nightly cron + backfill script.
        void syncMarketPrices(card.id, card.externalId, card.variant, { eur: eurRate, usd: rate }).catch(() => {})
      } catch {
        // priceCache.cardId is unique — a concurrent insert already wrote it. Fine.
      }
    }
    return card ?? null
  } catch {
    // Concurrent insert won the race (or unique violation). Return the existing row.
    const [row] = await dbc.select().from(cards).where(eq(cards.externalId, apiCard.id)).limit(1)
    return row ?? null
  }
}
