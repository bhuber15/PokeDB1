import { sql, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { chunked } from '@/lib/prices/sync'
import { usdToGbp, eurToGbp } from '@/lib/pricing'
import type { AppSettings } from '@/lib/settings'
import type { NormalizedCard, NormalizedPrices } from '@/lib/sources/types'

export interface SweepResult { cardsSeen: number; newCards: number; pricesUpdated: number; failed: number }

const CHUNK = 100

// Idempotent upsert of a batch of normalized rows + their prices. Identity is
// healed on conflict (external_id is the key); prices convert native→pence at
// the shop's rates here (keeping money server-canonical). Shared by every
// game's sweep and the import script.
export async function upsertNormalizedCards(
  dbc: Db, rows: NormalizedCard[], settings: AppSettings, result: SweepResult,
): Promise<void> {
  if (rows.length === 0) return
  // Dedupe by external id within the batch: a single INSERT with two rows
  // sharing a conflict target raises SQLite's "ON CONFLICT DO UPDATE command
  // could not affect row a second time". YGOPRODeck lists a few cards with a
  // duplicated (set_code, rarity) printing — without this the whole sweep
  // throws. Last occurrence wins.
  const deduped = [...new Map(rows.map(r => [r.externalId, r])).values()]
  result.cardsSeen += deduped.length
  const ids = deduped.map(r => r.externalId)
  const existing = await dbc.select({ externalId: cards.externalId }).from(cards).where(inArray(cards.externalId, ids))
  const known = new Set(existing.map(r => r.externalId))
  result.newCards += deduped.filter(r => !known.has(r.externalId)).length

  const idByExternal = new Map<string, number>()
  for (const chunk of chunked(deduped, CHUNK)) {
    const inserted = await dbc.insert(cards).values(chunk.map(r => ({
      name: r.name, game: r.game, language: r.language, setName: r.setName, setNumber: r.setNumber,
      variant: r.variant, series: r.series, externalId: r.externalId,
      imageUrl: r.imageUrl, imageUrlLarge: r.imageUrlLarge,
    }))).onConflictDoUpdate({
      target: cards.externalId,
      set: {
        name: sql`excluded.name`, setName: sql`excluded.set_name`, setNumber: sql`excluded.set_number`,
        variant: sql`excluded.variant`, series: sql`excluded.series`,
        imageUrl: sql`excluded.image_url`, imageUrlLarge: sql`excluded.image_url_large`,
      },
    }).returning({ id: cards.id, externalId: cards.externalId })
    for (const r of inserted) idByExternal.set(r.externalId!, r.id)
  }

  const priceRows = deduped.flatMap(r => {
    const cardId = idByExternal.get(r.externalId)
    if (cardId == null) return []
    const market = usdToGbp(r.prices.tcgplayerUsd, settings.usdToGbp)
    return [{
      cardId,
      tcgplayerMarket: market,
      cardmarketTrend: eurToGbp(r.prices.cardmarketEur, settings.eurToGbp),
      lastSyncedAt: new Date().toISOString(),
      isHighValue: (market ?? 0) >= settings.highValueThreshold,
    }]
  })
  for (const chunk of chunked(priceRows, CHUNK)) {
    await dbc.insert(priceCache).values(chunk).onConflictDoUpdate({
      target: priceCache.cardId,
      set: {
        tcgplayerMarket: sql`excluded.tcgplayer_market`,
        cardmarketTrend: sql`excluded.cardmarket_trend`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        isHighValue: sql`excluded.is_high_value`,
      },
    })
    result.pricesUpdated += chunk.length
  }
}

// Price-only refresh of one already-known card by external id. Used by the
// per-card MTG/YGO refresh (Task 6): updates the market columns and stamps the
// freshness timestamps, without rewriting identity or recomputing isHighValue
// (which the sweep owns). Takes rates only — no settings round-trip per card.
export async function writePriceForExternalId(
  dbc: Db, externalId: string, prices: NormalizedPrices, rates: { usd: number; eur: number },
): Promise<void> {
  const [card] = await dbc.select({ id: cards.id }).from(cards).where(eq(cards.externalId, externalId))
  if (!card) return
  const now = new Date().toISOString()
  await dbc.insert(priceCache).values({
    cardId: card.id,
    tcgplayerMarket: usdToGbp(prices.tcgplayerUsd, rates.usd),
    cardmarketTrend: eurToGbp(prices.cardmarketEur, rates.eur),
    cardmarketSyncedAt: now, // mark "market checked" so search's on-demand refresh dedupes
    lastSyncedAt: now,
  }).onConflictDoUpdate({
    target: priceCache.cardId,
    set: {
      tcgplayerMarket: sql`excluded.tcgplayer_market`,
      cardmarketTrend: sql`excluded.cardmarket_trend`,
      cardmarketSyncedAt: sql`excluded.cardmarket_synced_at`,
      lastSyncedAt: sql`excluded.last_synced_at`,
    },
  })
}
