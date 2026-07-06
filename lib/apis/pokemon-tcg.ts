const BASE_URL = 'https://api.pokemontcg.io/v2'

type PriceRow = { market?: number; low?: number; mid?: number; high?: number }

export interface PokemonTCGCard {
  id: string
  name: string
  number: string
  rarity?: string
  set: { name: string; series: string; releaseDate: string }
  subtypes?: string[]
  supertypes?: string[]
  types?: string[]
  hp?: string
  images: { small: string; large: string }
  tcgplayer?: {
    url?: string
    prices?: {
      normal?: PriceRow
      holofoil?: PriceRow
      reverseHolofoil?: PriceRow
      '1stEditionHolofoil'?: PriceRow
      '1stEditionNormal'?: PriceRow
    }
  }
}

export interface PriceResult {
  market: number | null
  low: number | null
  mid: number | null
  high: number | null
}

export interface AllPrices {
  normal?: PriceRow
  holofoil?: PriceRow
  reverseHolofoil?: PriceRow
  '1stEditionHolofoil'?: PriceRow
  '1stEditionNormal'?: PriceRow
}

export interface PokemonTCGSet {
  name: string
  series: string
}

function headers(): Record<string, string> {
  const key = process.env.POKEMON_TCG_API_KEY
  return key ? { 'X-Api-Key': key } : {}
}

// The API regularly hangs under load; an interactive search must fail fast so
// the UI can show "no results" instead of a spinner that never resolves.
export const SEARCH_TIMEOUT_MS = 4000

export async function searchPokemonCards(
  query: string,
  pageSize = 30,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<PokemonTCGCard[]> {
  // Strip Lucene-special chars so a stray quote can't break the query syntax
  const safe = query.replace(/["\\:()*?~^]/g, ' ').trim()
  if (!safe) return []
  const params = new URLSearchParams({ q: `name:"${safe}*"`, pageSize: String(pageSize) })
  // no-store: live price lookups shouldn't hit Next's data cache (large responses can
  // fail the cache path and turn a repeat search into a 500).
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`)
  return (await res.json()).data as PokemonTCGCard[]
}

// One page of the full catalogue (ordered by id for stable pagination).
// ~80 pages of 250 cover the English catalogue; used by the nightly sweep
// and the one-time import, which are the same idempotent operation.
export async function fetchCardPage(
  page: number,
  pageSize = 250,
): Promise<{ cards: PokemonTCGCard[]; totalCount: number }> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    orderBy: 'id',
    select: 'id,name,number,set,subtypes,images,tcgplayer',
  })
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: headers(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return { cards: body.data as PokemonTCGCard[], totalCount: body.totalCount as number }
}

// Full set list in one call (174 sets as of 2026-07, well under one page) —
// used once by the series backfill script. The per-card sweep doesn't need
// this: it already gets set.series inline via each card's `set` field.
export async function fetchSets(): Promise<PokemonTCGSet[]> {
  const params = new URLSearchParams({ pageSize: '250', select: 'name,series' })
  const res = await fetch(`${BASE_URL}/sets?${params}`, {
    headers: headers(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`)
  return (await res.json()).data as PokemonTCGSet[]
}

export function extractBestPrice(card: PokemonTCGCard): PriceResult {
  const prices = card.tcgplayer?.prices
  if (!prices) return { market: null, low: null, mid: null, high: null }
  const p = prices.holofoil
    ?? prices['1stEditionHolofoil']
    ?? prices.normal
    ?? prices['1stEditionNormal']
    ?? prices.reverseHolofoil
  if (!p) return { market: null, low: null, mid: null, high: null }
  return {
    market: p.market ?? null,
    low: p.low ?? null,
    mid: p.mid ?? null,
    high: p.high ?? null,
  }
}

export function getAllPrices(card: PokemonTCGCard): AllPrices {
  return card.tcgplayer?.prices ?? {}
}
