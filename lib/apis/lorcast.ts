import { lorcastExternalId, type LorcanaFinish } from '@/lib/sources/external-id'
import type { NormalizedCard } from '@/lib/sources/types'

const API = 'https://api.lorcast.com/v0'
const HEADERS = { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)', Accept: 'application/json' }
export const LORCAST_TIMEOUT_MS = 30_000

export class LorcastError extends Error {}

export interface LorcastSet { id: string; code: string; name: string; released_at?: string }

// Prices arrive as numbers on /cards endpoints but as STRINGS on
// /sets/:code/cards (verified live 2026-07-27) — the type covers both.
export interface LorcastPrices { usd?: string | number | null; usd_foil?: string | number | null }

export interface LorcastCard {
  id: string
  name: string
  version?: string | null
  rarity?: string
  collector_number?: string
  lang?: string
  set?: { id?: string; code?: string; name?: string }
  image_uris?: { digital?: { small?: string; normal?: string; large?: string } }
  prices?: LorcastPrices | null
}

async function get(path: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(LORCAST_TIMEOUT_MS) })
  } catch (e) {
    throw new LorcastError(`Lorcast unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new LorcastError(`Lorcast ${res.status}`)
  return res.json()
}

export async function fetchLorcastSets(): Promise<LorcastSet[]> {
  const body = await get('/sets') as { results?: LorcastSet[] } | null
  return body?.results ?? []
}

// NB: unlike /sets and /cards/search, this endpoint returns a bare array.
export async function fetchLorcastSetCards(setCode: string): Promise<LorcastCard[]> {
  const body = await get(`/sets/${encodeURIComponent(setCode)}/cards`) as LorcastCard[] | null
  return Array.isArray(body) ? body : []
}

// One card by its stable crd_ id — per-card refresh.
export async function fetchLorcastCard(crdId: string): Promise<LorcastCard | null> {
  return await get(`/cards/${encodeURIComponent(crdId)}`) as LorcastCard | null
}

const money = (v: string | number | null | undefined): number | null => {
  const n = typeof v === 'number' ? v : v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// These tiers are cold-foil only in every physical product; everything else
// defaults to both finishes when Lorcast carries no price keys to signal them.
const FOIL_ONLY_RARITIES = new Set(['Enchanted', 'Epic', 'Iconic'])

// One row per physically-existing finish (decision 1 of the design note).
// Which finishes exist comes from price-KEY presence — a present key with a
// null/0 value still means "this finish exists, no price yet" (no-price
// workflow), while an absent prices object falls back to the rarity tier.
export function normalizeLorcastCard(card: LorcastCard): NormalizedCard[] {
  if (!card.id || !card.name) return []
  if ((card.lang ?? 'en') !== 'en') return [] // EN-only phase; drop stray languages
  const prices = card.prices ?? {}
  const finishes: LorcanaFinish[] = []
  if ('usd' in prices) finishes.push('nonfoil')
  if ('usd_foil' in prices) finishes.push('foil')
  if (finishes.length === 0) {
    finishes.push(...(FOIL_ONLY_RARITIES.has(card.rarity ?? '') ? ['foil' as const] : ['nonfoil' as const, 'foil' as const]))
  }
  const digital = card.image_uris?.digital
  return finishes.map(finish => ({
    game: 'lorcana' as const,
    language: 'EN' as const,
    // Lorcana display convention: "Elsa - Spirit of Winter"; actions/songs/
    // items have no version and keep the bare name.
    name: card.version ? `${card.name} - ${card.version}` : card.name,
    setName: card.set?.name ?? '',
    setNumber: card.collector_number ?? '',
    variant: finish === 'foil' ? 'Foil' : '',
    series: card.set?.code ?? null,
    externalId: lorcastExternalId(card.id, finish),
    imageUrl: digital?.small ?? null,
    imageUrlLarge: digital?.large ?? digital?.normal ?? null,
    prices: {
      tcgplayerUsd: money(finish === 'foil' ? prices.usd_foil : prices.usd),
      cardmarketEur: null, // Lorcast has no EUR figure; never fabricate one
    },
  }))
}
