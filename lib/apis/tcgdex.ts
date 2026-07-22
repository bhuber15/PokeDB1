const BASE = 'https://api.tcgdex.net/v2/en'

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
    res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}`, {
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
