const BASE = 'https://api.tcgdex.net/v2/en'

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

export async function fetchCardmarketPrices(
  externalId: string,
  variant?: string | null,
): Promise<{ trend: number | null; low: number | null; avg: number | null } | null> {
  try {
    const id = externalId.toLowerCase()
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}`, { next: { revalidate: 86400 } })
    if (!res.ok) return null
    const data = await res.json()
    const cm: TcgdexCardmarket | undefined = data?.pricing?.cardmarket
    if (!cm) return null
    const holo = isHolo(variant)
    return {
      trend: (holo ? cm['trend-holo'] : cm.trend) ?? cm.trend ?? null,
      low: (holo ? cm['low-holo'] : cm.low) ?? cm.low ?? null,
      avg: (holo ? cm['avg-holo'] : cm.avg) ?? cm.avg ?? null,
    }
  } catch {
    return null
  }
}
