const BASE_URL = 'https://api.pokemontcg.io/v2'

export interface PokemonTCGCard {
  id: string
  name: string
  number: string
  set: { name: string }
  subtypes?: string[]
  images: { small: string; large: string }
  tcgplayer?: {
    prices?: {
      normal?: { market?: number; low?: number; mid?: number; high?: number }
      holofoil?: { market?: number; low?: number; mid?: number; high?: number }
      reverseHolofoil?: { market?: number; low?: number; mid?: number; high?: number }
      '1stEditionHolofoil'?: { market?: number; low?: number; mid?: number; high?: number }
    }
  }
}

export interface PriceResult {
  market: number | null
  low: number | null
  mid: number | null
  high: number | null
}

function headers(): Record<string, string> {
  const key = process.env.POKEMON_TCG_API_KEY
  return key ? { 'X-Api-Key': key } : {}
}

export async function searchPokemonCards(query: string): Promise<PokemonTCGCard[]> {
  const params = new URLSearchParams({ q: `name:"${query}*"`, pageSize: '20' })
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: headers(),
    next: { revalidate: 3600 },
  })
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`)
  return (await res.json()).data as PokemonTCGCard[]
}

export function extractBestPrice(card: PokemonTCGCard): PriceResult {
  const prices = card.tcgplayer?.prices
  if (!prices) return { market: null, low: null, mid: null, high: null }
  const p = prices.holofoil
    ?? prices['1stEditionHolofoil']
    ?? prices.normal
    ?? prices.reverseHolofoil
  if (!p) return { market: null, low: null, mid: null, high: null }
  return {
    market: p.market ?? null,
    low: p.low ?? null,
    mid: p.mid ?? null,
    high: p.high ?? null,
  }
}
