import type { Db } from '@/lib/db'
import { type Game, type Language, GAMES } from '@/lib/games'
import type { AppSettings } from '@/lib/settings'
import { parseExternalId } from '@/lib/sources/external-id'
import { writePriceForExternalId, type SweepResult } from '@/lib/sources/upsert'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import { fetchScryfallCard, normalizeScryfallCard } from '@/lib/apis/scryfall'
import { fetchYgoprodeckCard, normalizeYgoCard } from '@/lib/apis/ygoprodeck'

export interface CatalogueSource {
  game: Game
  languages: Language[]
  sweep: (settings: AppSettings, dbc?: Db) => Promise<SweepResult>
  // Optional: re-price a single already-known card (in-stock + on-demand).
  // Rates-only (the caller already resolved them) — no per-card settings read.
  refreshPrices?: (externalId: string, rates: { usd: number; eur: number }, dbc: Db) => Promise<void>
}

// One catalogue-writing source per game (spec §2: exactly one per (game,
// language) — Pokémon's EN/CJK split lives inside its own sync path, not here).
// Pokémon keeps its existing sweep path (lib/prices/*), so it is intentionally
// absent from this registry; getCatalogueSource returns undefined and callers
// fall back to the Pokémon-specific machinery. MTG/YGO are fully registry-driven.
const scryfallRefresh: CatalogueSource['refreshPrices'] = async (externalId, rates, dbc) => {
  const parsed = parseExternalId(externalId)
  if (parsed.source !== 'scryfall') return
  const card = await fetchScryfallCard(parsed.id)
  if (!card) return
  // normalize yields a row per finish; take the one matching this external id.
  const match = normalizeScryfallCard(card).find(r => r.externalId === externalId)
  if (match) await writePriceForExternalId(dbc, externalId, match.prices, rates)
}

const ygoRefresh: CatalogueSource['refreshPrices'] = async (externalId, rates, dbc) => {
  const parsed = parseExternalId(externalId)
  if (parsed.source !== 'ygoprodeck') return
  const card = await fetchYgoprodeckCard(parsed.passcode)
  if (!card) return
  const match = normalizeYgoCard(card).find(r => r.externalId === externalId)
  if (match) await writePriceForExternalId(dbc, externalId, match.prices, rates)
}

export const CATALOGUE_SOURCES: Partial<Record<Game, CatalogueSource>> = {
  mtg: { game: 'mtg', languages: GAMES.mtg.languages, sweep: (s, dbc) => sweepScryfall(s, dbc), refreshPrices: scryfallRefresh },
  yugioh: { game: 'yugioh', languages: GAMES.yugioh.languages, sweep: (s, dbc) => sweepYgoprodeck(s, dbc), refreshPrices: ygoRefresh },
}

export function getCatalogueSource(game: Game): CatalogueSource | undefined {
  return CATALOGUE_SOURCES[game]
}
