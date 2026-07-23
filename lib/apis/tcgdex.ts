const base = (tcgdexLang: string) => `https://api.tcgdex.net/v2/${tcgdexLang}`

// TCGdex regularly answers in well under a second; anything slower should fail
// fast — this client sits inside interactive search as well as the cron.
export const TCGDEX_TIMEOUT_MS = 4000

// Transient failure (network, timeout, upstream 5xx): the card may well have
// prices, we just couldn't get them — callers should retry later and must NOT
// record the attempt as a completed check. Distinct from a `null` return,
// which means TCGdex answered and has no Cardmarket pricing for this card.
export class TcgdexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TcgdexError'
  }
}

interface TcgdexCardmarket {
  unit?: string
  trend?: number; low?: number; avg?: number
  'trend-holo'?: number; 'low-holo'?: number; 'avg-holo'?: number
}

function isHolo(variant?: string | null): boolean {
  if (!variant) return false
  const v = variant.toLowerCase()
  return v.includes('holo') || v.includes('gx') || v.includes('ex') || v.includes('vmax') || v.includes('vstar') || v.includes('v ')
}

// Shared JSON fetcher with the client's existing error semantics (404 → null, transient → TcgdexError)
async function fetchTcgdexJson<T>(url: string): Promise<T | null> {
  let res: Response
  try {
    res = await fetch(url, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(TCGDEX_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TcgdexError(`TCGdex unreachable for ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new TcgdexError(`TCGdex ${res.status} for ${url}`)
  try {
    return await res.json() as T
  } catch {
    throw new TcgdexError(`TCGdex returned malformed JSON for ${url}`)
  }
}

// Catalogue types
export interface TcgdexSetBrief {
  id: string
  name: string
  cardCount: { total: number; official: number }
}

export interface TcgdexCardBrief {
  id: string       // e.g. "SV4a-006" — case preserved
  localId: string  // e.g. "006"
  name: string     // localized
  image?: string   // base URL — append /low.webp or /high.webp
}

export interface TcgdexSetDetail {
  id: string
  name: string
  releaseDate?: string
  serie?: { id: string; name: string }
  cards: TcgdexCardBrief[]
}

// Catalogue fetchers
export async function fetchTcgdexSets(tcgdexLang: string): Promise<TcgdexSetBrief[]> {
  return (await fetchTcgdexJson<TcgdexSetBrief[]>(`${base(tcgdexLang)}/sets`)) ?? []
}

export async function fetchTcgdexSet(tcgdexLang: string, setId: string): Promise<TcgdexSetDetail | null> {
  return fetchTcgdexJson<TcgdexSetDetail>(`${base(tcgdexLang)}/sets/${encodeURIComponent(setId)}`)
}

// Pricing types and extraction
interface TcgdexTcgplayerVariant {
  marketPrice?: number; lowPrice?: number; midPrice?: number; highPrice?: number
}

export interface TcgdexCardData {
  dexId: number[] | null
  cardmarket: { trend: number | null; low: number | null; avg: number | null } | null // EUR
  tcgplayer: { market: number | null; low: number | null; mid: number | null; high: number | null } | null // USD
}

// TCGdex emits 0 for prices it doesn't have — 0 is "no data", not a price.
const pos = (v: number | null | undefined): number | null => (v && v > 0 ? v : null)

export function extractTcgdexPricing(
  data: { dexId?: number[]; pricing?: { cardmarket?: TcgdexCardmarket | null; tcgplayer?: Record<string, unknown> | null } },
  variant: string | null | undefined,
): TcgdexCardData {
  const cm = data.pricing?.cardmarket ?? null
  let cardmarket: TcgdexCardData['cardmarket'] = null
  if (cm) {
    const holo = isHolo(variant)
    const trend = pos((holo ? cm['trend-holo'] : cm.trend) ?? cm.trend)
    const low = pos((holo ? cm['low-holo'] : cm.low) ?? cm.low)
    const avg = pos((holo ? cm['avg-holo'] : cm.avg) ?? cm.avg)
    if (trend != null || low != null || avg != null) cardmarket = { trend, low, avg }
  }

  const tpBlock = data.pricing?.tcgplayer ?? null
  let tcgplayer: TcgdexCardData['tcgplayer'] = null
  if (tpBlock) {
    // Variant-keyed like pokemontcg.io; prefer holo-ish printings, else first present.
    const candidates = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal']
    let v: TcgdexTcgplayerVariant | undefined
    for (const k of candidates) {
      const b = tpBlock[k]
      if (b && typeof b === 'object') { v = b as TcgdexTcgplayerVariant; break }
    }
    if (!v) v = Object.values(tpBlock).find((b): b is TcgdexTcgplayerVariant => !!b && typeof b === 'object')
    if (v) {
      const market = pos(v.marketPrice); const low = pos(v.lowPrice)
      const mid = pos(v.midPrice); const high = pos(v.highPrice)
      if (market != null || low != null || mid != null || high != null) tcgplayer = { market, low, mid, high }
    }
  }

  return { dexId: data.dexId?.length ? data.dexId : null, cardmarket, tcgplayer }
}

// Full card fetch for the price rotation + alias backfill. Uses the raw id
// verbatim — TCGdex CJK ids are mixed-case; do NOT lowercase (that is an
// EN-only quirk of fetchCardmarketPrices).
export async function fetchTcgdexCard(tcgdexLang: string, rawId: string): Promise<TcgdexCardData | null> {
  const data = await fetchTcgdexJson<{ dexId?: number[]; pricing?: { cardmarket?: TcgdexCardmarket | null; tcgplayer?: Record<string, unknown> | null } }>(
    `${base(tcgdexLang)}/cards/${encodeURIComponent(rawId)}`)
  if (!data) return null
  return extractTcgdexPricing(data, null)
}

// Returns EUR decimal prices, `null` when TCGdex has no Cardmarket data for
// the card (unknown id, or no pricing block), and throws TcgdexError on
// transient failures so sync bookkeeping can tell "no data" from "try again".
export async function fetchCardmarketPrices(
  externalId: string,
  variant?: string | null,
): Promise<{ trend: number | null; low: number | null; avg: number | null } | null> {
  const id = externalId.toLowerCase()
  let res: Response
  try {
    res = await fetch(`${base('en')}/cards/${encodeURIComponent(id)}`, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(TCGDEX_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TcgdexError(`TCGdex unreachable for ${id}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new TcgdexError(`TCGdex ${res.status} for ${id}`)
  let data: { pricing?: { cardmarket?: TcgdexCardmarket } }
  try {
    data = await res.json()
  } catch {
    throw new TcgdexError(`TCGdex returned malformed JSON for ${id}`)
  }
  const cm = data?.pricing?.cardmarket
  if (!cm) return null
  const holo = isHolo(variant)
  // TCGdex emits 0 for prices it doesn't have — 0 is "no data", not a price.
  const pos = (v: number | null | undefined): number | null => (v && v > 0 ? v : null)
  const trend = pos((holo ? cm['trend-holo'] : cm.trend) ?? cm.trend)
  const low = pos((holo ? cm['low-holo'] : cm.low) ?? cm.low)
  const avg = pos((holo ? cm['avg-holo'] : cm.avg) ?? cm.avg)
  // An all-empty pricing block is the same answer as no block at all.
  if (trend == null && low == null && avg == null) return null
  return { trend, low, avg }
}
