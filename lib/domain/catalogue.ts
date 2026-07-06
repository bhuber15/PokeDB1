// lib/domain/catalogue.ts
//
// Read-only catalogue browsing: sets grouped by era, all cards in a set,
// distinct card names, and every printing of an exact name. Powers the
// Catalogue tab and the Buy page's Browse mode. No writes — unlike
// sales/refunds/buys, this module has no domain invariants to enforce.

import { and, asc, eq, like, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import type { Card, PriceCache } from '@/lib/db/schema'

// Chronological release order. A series not listed here (including null —
// pre-backfill rows, or a set the API hasn't categorised yet) sorts last,
// into an "Other" bucket in the UI.
export const SERIES_ORDER = [
  'Base', 'Neo', 'Gym', 'e-Card', 'EX', 'Diamond & Pearl', 'Platinum',
  'HeartGold & SoulSilver', 'Call of Legends', 'Black & White',
  'XY', 'Sun & Moon', 'Sword & Shield', 'Scarlet & Violet',
] as const

function seriesRank(series: string | null): number {
  if (series == null) return SERIES_ORDER.length + 1
  const idx = (SERIES_ORDER as readonly string[]).indexOf(series)
  return idx === -1 ? SERIES_ORDER.length : idx
}

// Set numbers are mostly numeric strings ("58", "TG12") — compare
// numerically when both sides parse as plain numbers, else fall back to
// string comparison, so "9" sorts before "10".
function naturalCompare(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b)
}

export interface SetSummary {
  setName: string
  series: string | null
  count: number
}

/** Every distinct set in the catalogue, ordered by era then set name. */
export async function getSets(dbc: Db = db): Promise<SetSummary[]> {
  const rows = await dbc
    .select({ setName: cards.setName, series: cards.series, count: sql<number>`COUNT(*)` })
    .from(cards)
    .groupBy(cards.setName, cards.series)
  return rows.sort((a, b) =>
    seriesRank(a.series) - seriesRank(b.series) || a.setName.localeCompare(b.setName))
}

export interface CatalogueRow {
  card: Card
  prices: PriceCache | null
}

/** All cards in one set, ordered by set number, left-joined to price_cache. */
export async function getCardsInSet(setName: string, dbc: Db = db): Promise<CatalogueRow[]> {
  const rows = await dbc
    .select({ card: cards, prices: priceCache })
    .from(cards)
    .leftJoin(priceCache, eq(priceCache.cardId, cards.id))
    .where(eq(cards.setName, setName))
  return rows.sort((a, b) => naturalCompare(a.card.setNumber, b.card.setNumber))
}

const NAME_LIMIT = 50

/** Distinct card names, optionally prefix-filtered, capped and alphabetised. */
export async function getNames(q: string | undefined, dbc: Db = db): Promise<string[]> {
  const rows = await dbc.selectDistinct({ name: cards.name }).from(cards)
    .where(like(cards.name, `${q ?? ''}%`))
    .orderBy(asc(cards.name))
    .limit(NAME_LIMIT)
  return rows.map(r => r.name)
}

/** Every printing of an exact card name, ordered by era then set number. */
export async function getPrintingsByName(name: string, dbc: Db = db): Promise<CatalogueRow[]> {
  const rows = await dbc
    .select({ card: cards, prices: priceCache })
    .from(cards)
    .leftJoin(priceCache, eq(priceCache.cardId, cards.id))
    .where(eq(cards.name, name))
  return rows.sort((a, b) =>
    seriesRank(a.card.series) - seriesRank(b.card.series) || naturalCompare(a.card.setNumber, b.card.setNumber))
}
