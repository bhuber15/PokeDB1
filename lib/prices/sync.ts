import { sql, eq, and, inArray, lt } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, inventoryItems, priceCache, priceHistory } from '@/lib/db/schema'
import { fetchCardmarketPrices } from '@/lib/apis/tcgdex'
import { fetchCardPage, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { eurToGbp, usdToGbp } from '@/lib/pricing'
import type { AppSettings } from '@/lib/settings'

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

export async function syncCardmarketForCard(
  cardId: number, externalId: string | null, variant: string | null, eurRate: number, dbc: Db = db,
): Promise<void> {
  if (!externalId) return
  const cm = await fetchCardmarketPrices(externalId, variant)
  if (!cm) return
  const trend = eurToGbp(cm.trend, eurRate)
  await dbc.insert(priceCache).values({
    cardId,
    cardmarketTrend: trend,
    cardmarketLow: eurToGbp(cm.low, eurRate),
    cardmarketAvg: eurToGbp(cm.avg, eurRate),
    cardmarketSyncedAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: priceCache.cardId,
    set: {
      cardmarketTrend: sql`excluded.cardmarket_trend`,
      cardmarketLow: sql`excluded.cardmarket_low`,
      cardmarketAvg: sql`excluded.cardmarket_avg`,
      cardmarketSyncedAt: sql`excluded.cardmarket_synced_at`,
    },
  })
  if (await isInteresting(dbc, cardId)) {
    await dbc.insert(priceHistory).values({ cardId, cardmarketTrend: trend, recordedOn: today() })
      .onConflictDoUpdate({
        target: [priceHistory.cardId, priceHistory.recordedOn],
        set: { cardmarketTrend: sql`excluded.cardmarket_trend` },
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

function chunked<T>(arr: T[], size: number): T[][] {
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
      batch.map(c => syncCardmarketForCard(c.id, c.externalId, c.variant, settings.eurToGbp, dbc)),
    )
    for (const r of results) r.status === 'fulfilled' ? synced++ : failed++
  }
  return { synced, failed }
}

export async function pruneOldHistory(dbc: Db = db): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  await dbc.delete(priceHistory).where(lt(priceHistory.recordedOn, cutoff))
}
