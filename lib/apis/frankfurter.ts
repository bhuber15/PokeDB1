const URL = 'https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD,EUR'
export const FRANKFURTER_TIMEOUT_MS = 10_000

export class FrankfurterError extends Error {}

// Plausibility band for a GBP-per-unit rate. USD→GBP has lived in 0.47–0.95
// and EUR→GBP in 0.57–0.98 since 1999, so [0.3, 1.1] leaves real headroom —
// while still rejecting an un-inverted quote (1/0.79 ≈ 1.27, which would
// silently reprice the whole catalogue ~60% high) and any unit slip.
const MIN_RATE = 0.3
const MAX_RATE = 1.1

// Frankfurter quotes how many USD/EUR one pound buys; the settings columns
// store the opposite (pounds per dollar/euro), so invert. 4 dp is ±0.005% on a
// converted price and keeps the Settings input readable.
function invert(perGbp: unknown, ccy: string): number {
  if (typeof perGbp !== 'number' || !Number.isFinite(perGbp) || perGbp <= 0) {
    throw new FrankfurterError(`Frankfurter ${ccy} rate missing or invalid: ${String(perGbp)}`)
  }
  const rate = Math.round((1 / perGbp) * 1e4) / 1e4
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw new FrankfurterError(`Frankfurter ${ccy} rate implausible after inversion: ${rate}`)
  }
  return rate
}

export function extractGbpRates(body: { rates?: { USD?: unknown; EUR?: unknown } } | null | undefined): { usd: number; eur: number } {
  return { usd: invert(body?.rates?.USD, 'USD'), eur: invert(body?.rates?.EUR, 'EUR') }
}

// The ECB's daily reference rates via Frankfurter (free, keyless, one figure
// per working day — weekends answer with Friday's). Throws FrankfurterError on
// anything but two in-band positive rates; callers treat that as "keep the
// rates we already have", never as data.
export async function fetchEcbGbpRates(): Promise<{ usd: number; eur: number }> {
  let res: Response
  try {
    res = await fetch(URL, { cache: 'no-store', signal: AbortSignal.timeout(FRANKFURTER_TIMEOUT_MS) })
  } catch (e) {
    throw new FrankfurterError(`Frankfurter unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new FrankfurterError(`Frankfurter ${res.status}`)
  try {
    return extractGbpRates(await res.json())
  } catch (e) {
    if (e instanceof FrankfurterError) throw e
    throw new FrankfurterError('Frankfurter returned malformed JSON')
  }
}
