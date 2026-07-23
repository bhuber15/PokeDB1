import { or, like, eq, and, sql, inArray, type SQL } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, priceCache, type Card, type PriceCache } from '@/lib/db/schema'
import { type Game, type Language } from '@/lib/games'
import { searchPokemonCards, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { getSettings } from '@/lib/settings'
import { usdToGbp } from '@/lib/pricing'
import { syncMarketPricesForCard, refreshStaleCardmarket } from '@/lib/prices/sync'
import { similarity } from '@/lib/fuzzy'

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

  const fuzzyMatches = await searchFuzzy(q, dbc, scope)
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

// Score every distinct catalogue name (and EN alias, for CJK rows) against
// the query in memory (~20k names, a few ms — no SQLite extension needed on
// Turso), then pull all printings of the closest few names.
async function searchFuzzy(q: string, dbc: Db, scope: SQL[]): Promise<Card[]> {
  const names = await dbc.selectDistinct({ name: cards.name, aliasName: cards.aliasName })
    .from(cards)
    .where(scope.length ? and(...scope) : undefined)
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
