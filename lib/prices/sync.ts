import { sql, eq, and, or, inArray, lt, asc, isNull, isNotNull } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, inventoryItems, priceCache, priceHistory, type Card } from '@/lib/db/schema'
import { fetchCardmarketPrices, fetchTcgdexCard } from '@/lib/apis/tcgdex'
import { fetchCardPage, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { eurToGbp, usdToGbp, isCardmarketFresh } from '@/lib/pricing'
import { getSettings, type AppSettings } from '@/lib/settings'
import { parseExternalId } from '@/lib/sources/external-id'
import { aliasForDexIds } from '@/lib/pokedex'
import { TCGDEX_LANGS, type Language } from '@/lib/games'

const today = () => new Date().toISOString().slice(0, 10)

// History is only recorded for cards someone could care about the trend of:
// in stock, or flagged high-value. 90 days for the full catalogue would be
// millions of rows with no reporting benefit.
async function isInteresting(dbc: Db, cardId: number): Promise<boolean> {
  const [row] = await dbc.select({ id: inventoryItems.id }).from(inventoryItems)
    .where(and(eq(inventoryItems.cardId, cardId), eq(inventoryItems.isActive, true))).limit(1)
  if (row) return true
  const [pc] = await dbc.select({ hv: priceCache.isHighValue }).from(priceCache)
    .where(eq(priceCache.cardId, cardId)).limit(1)
  return pc?.hv ?? false
}

// Per-card marketplace sync. EN rows (bare pokemontcg.io ids) fetch the
// TCGdex/en Cardmarket block exactly as before; tcgdex:<lang>:<id> rows fetch
// the per-language card, write BOTH column families (Cardmarket EUR +
// TCGplayer USD — TCGdex embeds both), and backfill cards.aliasName from
// dexId while the response is in hand. Propagates TcgdexError on transient
// failures (so sweeps count them as failed and retry another night).
// `opts.interesting` lets batch callers precompute the history gate instead
// of paying two lookups per card.
export async function syncMarketPricesForCard(
  cardId: number, externalId: string | null, variant: string | null,
  rates: { eur: number; usd: number }, dbc: Db = db,
  opts: { interesting?: boolean } = {},
): Promise<void> {
  if (!externalId) return
  const parsed = parseExternalId(externalId)
  // 'EN' guard: a hypothetical tcgdex:en:… id has no TCGDEX_LANGS entry —
  // EN always takes the pokemontcg.io path below.
  if (parsed.source === 'tcgdex' && parsed.language !== 'EN') {
    return syncTcgdexCard(cardId, parsed.language, parsed.id, rates, dbc, opts)
  }
  const cm = await fetchCardmarketPrices(externalId, variant)
  const syncedAt = new Date().toISOString()
  if (!cm) {
    // TCGdex answered but has no Cardmarket pricing for this card. Record the
    // check (keeping any previously cached values) so the nightly rotation and
    // the on-demand refresh move on instead of re-asking the same cards forever.
    await dbc.insert(priceCache).values({ cardId, cardmarketSyncedAt: syncedAt })
      .onConflictDoUpdate({
        target: priceCache.cardId,
        set: { cardmarketSyncedAt: sql`excluded.cardmarket_synced_at` },
      })
    return
  }
  const trend = eurToGbp(cm.trend, rates.eur)
  await dbc.insert(priceCache).values({
    cardId,
    cardmarketTrend: trend,
    cardmarketLow: eurToGbp(cm.low, rates.eur),
    cardmarketAvg: eurToGbp(cm.avg, rates.eur),
    cardmarketSyncedAt: syncedAt,
  }).onConflictDoUpdate({
    target: priceCache.cardId,
    set: {
      cardmarketTrend: sql`excluded.cardmarket_trend`,
      cardmarketLow: sql`excluded.cardmarket_low`,
      cardmarketAvg: sql`excluded.cardmarket_avg`,
      cardmarketSyncedAt: sql`excluded.cardmarket_synced_at`,
    },
  })
  if (opts.interesting ?? await isInteresting(dbc, cardId)) {
    await dbc.insert(priceHistory).values({ cardId, cardmarketTrend: trend, recordedOn: today() })
      .onConflictDoUpdate({
        target: [priceHistory.cardId, priceHistory.recordedOn],
        set: { cardmarketTrend: sql`excluded.cardmarket_trend` },
      })
  }
}

// tcgdex:<lang>:<id> branch — full per-language card fetch (not just the
// pricing block), because the same response also carries the dexId used to
// backfill the EN alias. Writes both Cardmarket (EUR) and TCGplayer (USD)
// column families since TCGdex embeds both in one payload.
async function syncTcgdexCard(
  cardId: number, language: Exclude<Language, 'EN'>, rawId: string,
  rates: { eur: number; usd: number }, dbc: Db,
  opts: { interesting?: boolean },
): Promise<void> {
  const card = await fetchTcgdexCard(TCGDEX_LANGS[language], rawId)
  const syncedAt = new Date().toISOString()

  // Alias backfill piggybacks on the fetch — fills blanks only.
  const alias = aliasForDexIds(card?.dexId)
  if (alias) {
    await dbc.update(cards).set({ aliasName: alias })
      .where(and(eq(cards.id, cardId), isNull(cards.aliasName)))
  }

  const cm = card?.cardmarket ?? null
  const tp = card?.tcgplayer ?? null
  if (!cm && !tp) {
    // Answered with no marketplace data (the JP-exclusive norm) or unknown id:
    // record the check so the rotation moves on, keep any cached values.
    await dbc.insert(priceCache).values({ cardId, cardmarketSyncedAt: syncedAt })
      .onConflictDoUpdate({
        target: priceCache.cardId,
        set: { cardmarketSyncedAt: sql`excluded.cardmarket_synced_at` },
      })
    return
  }

  const trend = eurToGbp(cm?.trend ?? null, rates.eur)
  const values = {
    cardId,
    cardmarketTrend: trend,
    cardmarketLow: eurToGbp(cm?.low ?? null, rates.eur),
    cardmarketAvg: eurToGbp(cm?.avg ?? null, rates.eur),
    cardmarketSyncedAt: syncedAt,
    tcgplayerMarket: usdToGbp(tp?.market ?? null, rates.usd),
    tcgplayerLow: usdToGbp(tp?.low ?? null, rates.usd),
    tcgplayerMid: usdToGbp(tp?.mid ?? null, rates.usd),
    tcgplayerHigh: usdToGbp(tp?.high ?? null, rates.usd),
    lastSyncedAt: syncedAt,
  }
  // Only overwrite the column family the response actually carried — a
  // present cardmarket block with an absent tcgplayer block must not null
  // out previously cached TCGplayer values (and vice versa).
  const set: Record<string, unknown> = { cardmarketSyncedAt: sql`excluded.cardmarket_synced_at` }
  if (cm) {
    set.cardmarketTrend = sql`excluded.cardmarket_trend`
    set.cardmarketLow = sql`excluded.cardmarket_low`
    set.cardmarketAvg = sql`excluded.cardmarket_avg`
  }
  if (tp) {
    set.tcgplayerMarket = sql`excluded.tcgplayer_market`
    set.tcgplayerLow = sql`excluded.tcgplayer_low`
    set.tcgplayerMid = sql`excluded.tcgplayer_mid`
    set.tcgplayerHigh = sql`excluded.tcgplayer_high`
    set.lastSyncedAt = sql`excluded.last_synced_at`
  }
  await dbc.insert(priceCache).values(values)
    .onConflictDoUpdate({ target: priceCache.cardId, set })

  if (opts.interesting ?? await isInteresting(dbc, cardId)) {
    await dbc.insert(priceHistory).values({
      cardId, cardmarketTrend: trend, tcgplayerMarket: values.tcgplayerMarket, recordedOn: today(),
    }).onConflictDoUpdate({
      target: [priceHistory.cardId, priceHistory.recordedOn],
      set: {
        ...(cm ? { cardmarketTrend: sql`excluded.cardmarket_trend` } : {}),
        ...(tp ? { tcgplayerMarket: sql`excluded.tcgplayer_market` } : {}),
      },
    })
  }
}

export interface SweepResult {
  pagesFetched: number
  pagesFailed: number
  cardsSeen: number
  newCards: number
  pricesUpdated: number
}

const CHUNK = 100 // rows per multi-row statement, well under SQLite's param limit

export function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// The catalogue sweep: pages through the full Pokemon TCG API catalogue,
// inserting unknown cards (initial import + new sets) and refreshing
// TCGplayer prices for every card. Idempotent — the one-time import and the
// nightly refresh are the same call. Per-page failure isolation: a bad page
// is counted and skipped.
export async function sweepTcgplayerCatalogue(
  settings: AppSettings, opts: { maxPages?: number; pageSize?: number } = {}, dbc: Db = db,
  onPage?: (page: number, result: SweepResult) => void,
): Promise<SweepResult> {
  const pageSize = opts.pageSize ?? 250
  const result: SweepResult = { pagesFetched: 0, pagesFailed: 0, cardsSeen: 0, newCards: 0, pricesUpdated: 0 }

  const stocked = await dbc.selectDistinct({ cardId: inventoryItems.cardId }).from(inventoryItems)
    .where(eq(inventoryItems.isActive, true))
  const stockedIds = new Set(stocked.map(r => r.cardId).filter((id): id is number => id != null))

  let page = 1
  let totalCount = Infinity
  let consecutiveFailures = 0
  while ((page - 1) * pageSize < totalCount && page <= (opts.maxPages ?? 200)) {
    try {
      const { cards: apiCards, totalCount: tc } = await fetchCardPage(page, pageSize)
      totalCount = tc
      result.pagesFetched++
      if (apiCards.length === 0) break
      await upsertPage(dbc, apiCards, settings, stockedIds, result)
      consecutiveFailures = 0
    } catch {
      result.pagesFailed++
      if (++consecutiveFailures >= 3) break // API is down — stop hammering it
    }
    onPage?.(page, result)
    page++
  }
  return result
}

async function upsertPage(
  dbc: Db, apiCards: PokemonTCGCard[], settings: AppSettings,
  stockedIds: Set<number>, result: SweepResult,
): Promise<void> {
  const withId = apiCards.filter(c => c.id)
  result.cardsSeen += withId.length
  const externalIds = withId.map(c => c.id)

  // Count which are new, then upsert every card on the page. The API is
  // authoritative for card identity — on conflict we refresh name/set/number/
  // images, which heals mislabelled hand-entered rows (e.g. a CSV row whose
  // set number pointed at a different card).
  const existing = await dbc.select({ externalId: cards.externalId }).from(cards)
    .where(inArray(cards.externalId, externalIds))
  const known = new Set(existing.map(r => r.externalId))
  result.newCards += withId.filter(c => !known.has(c.id)).length

  const idByExternal = new Map<string, number>()
  for (const chunk of chunked(withId, CHUNK)) {
    const rows = await dbc.insert(cards).values(chunk.map(c => ({
      name: c.name,
      game: 'pokemon',
      setName: c.set?.name ?? '',
      setNumber: c.number ?? '',
      variant: c.subtypes?.join('/') ?? null,
      series: c.set?.series ?? null,
      externalId: c.id,
      imageUrl: c.images?.small ?? null,
      imageUrlLarge: c.images?.large ?? null,
    }))).onConflictDoUpdate({
      target: cards.externalId,
      set: {
        name: sql`excluded.name`,
        setName: sql`excluded.set_name`,
        setNumber: sql`excluded.set_number`,
        variant: sql`excluded.variant`,
        series: sql`excluded.series`,
        imageUrl: sql`excluded.image_url`,
        imageUrlLarge: sql`excluded.image_url_large`,
      },
    }).returning({ id: cards.id, externalId: cards.externalId })
    for (const r of rows) idByExternal.set(r.externalId!, r.id)
  }

  // Refresh TCGplayer prices for every card on the page
  const priceRows = withId.flatMap(c => {
    const cardId = idByExternal.get(c.id)
    if (cardId == null) return []
    const p = extractBestPrice(c)
    const market = usdToGbp(p.market, settings.usdToGbp)
    return [{
      cardId,
      tcgplayerMarket: market,
      tcgplayerLow: usdToGbp(p.low, settings.usdToGbp),
      tcgplayerMid: usdToGbp(p.mid, settings.usdToGbp),
      tcgplayerHigh: usdToGbp(p.high, settings.usdToGbp),
      lastSyncedAt: new Date().toISOString(),
      isHighValue: (market ?? 0) >= settings.highValueThreshold,
    }]
  })
  for (const chunk of chunked(priceRows, CHUNK)) {
    await dbc.insert(priceCache).values(chunk).onConflictDoUpdate({
      target: priceCache.cardId,
      set: {
        tcgplayerMarket: sql`excluded.tcgplayer_market`,
        tcgplayerLow: sql`excluded.tcgplayer_low`,
        tcgplayerMid: sql`excluded.tcgplayer_mid`,
        tcgplayerHigh: sql`excluded.tcgplayer_high`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        isHighValue: sql`excluded.is_high_value`,
      },
    })
    result.pricesUpdated += chunk.length
  }

  // Daily history snapshot for the interesting subset only
  const historyRows = priceRows
    .filter(r => stockedIds.has(r.cardId) || r.isHighValue)
    .map(r => ({ cardId: r.cardId, tcgplayerMarket: r.tcgplayerMarket, recordedOn: today() }))
  for (const chunk of chunked(historyRows, CHUNK)) {
    await dbc.insert(priceHistory).values(chunk).onConflictDoUpdate({
      target: [priceHistory.cardId, priceHistory.recordedOn],
      set: { tcgplayerMarket: sql`excluded.tcgplayer_market` },
    })
  }
}

// Cardmarket (TCGdex) is per-card — scoped to in-stock cards, in concurrent
// batches with per-card failure isolation.
export async function syncInStockCardmarket(
  settings: AppSettings, dbc: Db = db,
): Promise<{ synced: number; failed: number }> {
  const inStock = await dbc.selectDistinct({ id: cards.id, externalId: cards.externalId, variant: cards.variant })
    .from(cards)
    .innerJoin(inventoryItems, and(eq(inventoryItems.cardId, cards.id), eq(inventoryItems.isActive, true)))
  let synced = 0
  let failed = 0
  for (const batch of chunked(inStock, 8)) {
    const results = await Promise.allSettled(
      // In stock by construction, so the history gate is a given.
      batch.map(c => syncMarketPricesForCard(
        c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, dbc, { interesting: true },
      )),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') synced++
      else failed++
    }
  }
  return { synced, failed }
}

// Nightly Cardmarket rotation across the whole catalogue. In-stock cards are
// re-synced every night by syncInStockCardmarket; this walks the rest
// stalest-first (never-checked cards first), so buy offers for cards the shop
// does NOT stock are priced off Cardmarket instead of silently falling back
// to TCGplayer USD. Bounded by count and wall-clock so the cron fits its
// function budget: at ~2,000 cards/night the ~20k catalogue refreshes about
// fortnightly.
export const CARDMARKET_ROTATION_LIMIT = 2000
export const CARDMARKET_ROTATION_BUDGET_MS = 60_000
// Skip cards checked within the last 20h so a catalogue smaller than the
// nightly limit is fetched at most once per daily cron run.
const ROTATION_MIN_AGE_MS = 20 * 3600 * 1000

export interface RotationResult { synced: number; failed: number; remaining: number }

export async function syncStaleCardmarket(
  settings: AppSettings,
  opts: { limit?: number; timeBudgetMs?: number } = {},
  dbc: Db = db,
): Promise<RotationResult> {
  const limit = opts.limit ?? CARDMARKET_ROTATION_LIMIT
  const deadline = Date.now() + (opts.timeBudgetMs ?? CARDMARKET_ROTATION_BUDGET_MS)
  const cutoff = new Date(Date.now() - ROTATION_MIN_AGE_MS).toISOString()

  const candidates = await dbc.select({
    id: cards.id, externalId: cards.externalId, variant: cards.variant,
    isHighValue: priceCache.isHighValue,
  }).from(cards)
    .leftJoin(priceCache, eq(priceCache.cardId, cards.id))
    .where(and(
      isNotNull(cards.externalId),
      or(isNull(priceCache.cardmarketSyncedAt), lt(priceCache.cardmarketSyncedAt, cutoff)),
    ))
    .orderBy(asc(priceCache.cardmarketSyncedAt)) // NULLs (never checked) sort first
    .limit(limit)

  // Precompute the history gate once — per-card isInteresting lookups would
  // triple the DB round-trips over a 2,000-card batch.
  const stocked = await dbc.selectDistinct({ cardId: inventoryItems.cardId }).from(inventoryItems)
    .where(eq(inventoryItems.isActive, true))
  const stockedIds = new Set(stocked.map(r => r.cardId).filter((id): id is number => id != null))

  const result: RotationResult = { synced: 0, failed: 0, remaining: candidates.length }
  for (const batch of chunked(candidates, 8)) {
    if (Date.now() >= deadline) break
    const results = await Promise.allSettled(batch.map(c =>
      syncMarketPricesForCard(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, dbc,
        { interesting: stockedIds.has(c.id) || (c.isHighValue ?? false) }),
    ))
    for (const r of results) {
      if (r.status === 'fulfilled') result.synced++
      else result.failed++
    }
    result.remaining -= batch.length
  }
  return result
}

// Bounded on-demand refresh for interactive callers (buylist/card search):
// given the cards about to be priced, refresh Cardmarket for up to `maxCards`
// whose cache entry is missing or stale. Time-boxed and best-effort — a
// TCGdex outage must never break search. Returns how many cards were synced.
export const ON_DEMAND_MAX_CARDS = 12
export const ON_DEMAND_BUDGET_MS = 2500

export async function refreshStaleCardmarket(
  cardRows: Pick<Card, 'id' | 'externalId' | 'variant'>[],
  dbc: Db = db,
  opts: { maxCards?: number; timeBudgetMs?: number; sync?: typeof syncMarketPricesForCard } = {},
): Promise<number> {
  const withExternal = cardRows.filter(c => c.externalId != null)
  if (withExternal.length === 0) return 0
  const cache = await dbc.select({ cardId: priceCache.cardId, syncedAt: priceCache.cardmarketSyncedAt })
    .from(priceCache).where(inArray(priceCache.cardId, withExternal.map(c => c.id)))
  const syncedAtByCard = new Map(cache.map(r => [r.cardId, r.syncedAt]))
  // Callers pass rows in display order (best match first), so the bound keeps
  // the cards the user is actually looking at.
  const stale = withExternal
    .filter(c => !isCardmarketFresh(syncedAtByCard.get(c.id)))
    .slice(0, opts.maxCards ?? ON_DEMAND_MAX_CARDS)
  if (stale.length === 0) return 0

  const sync = opts.sync ?? syncMarketPricesForCard
  const settings = await getSettings(dbc)
  const deadline = Date.now() + (opts.timeBudgetMs ?? ON_DEMAND_BUDGET_MS)
  let refreshed = 0
  for (const batch of chunked(stale, 4)) {
    if (Date.now() >= deadline) break
    const results = await Promise.allSettled(
      batch.map(c => sync(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, dbc)),
    )
    refreshed += results.filter(r => r.status === 'fulfilled').length
  }
  return refreshed
}

export async function pruneOldHistory(dbc: Db = db): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  await dbc.delete(priceHistory).where(lt(priceHistory.recordedOn, cutoff))
}
