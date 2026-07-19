export function calculateSellPrice(
  marketPence: number | null | undefined,
  overridePence: number | null | undefined,
  multiplier = parseFloat(process.env.NEXT_PUBLIC_MARGIN_MULTIPLIER ?? '0.85') || 0.85
): number | null {
  if (overridePence != null) return overridePence
  if (marketPence == null) return null
  return Math.ceil(marketPence * multiplier)
}

export function formatGBP(pence: number | null | undefined): string {
  if (pence == null) return '—'
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100)
}

// Buy-in offer = market pence × percentage, floored so we never overpay by a rounding penny.
export function calculateBuyPrice(marketPence: number | null | undefined, pct: number): number | null {
  if (marketPence == null) return null
  return Math.floor(marketPence * pct)
}

// Parses a pounds-denominated form/CSV input string or number into integer pence.
// The only pounds→pence conversion point in the codebase.
export function parsePounds(input: string | number): number {
  const pounds = typeof input === 'number' ? input : parseFloat(input)
  if (!Number.isFinite(pounds)) return 0
  return Math.round(pounds * 100)
}

// Pokemon TCG API / TCGdex return prices as plain decimal numbers in their
// native currency (USD/EUR), not pence. Convert to GBP pence at a configurable rate.
export function usdToGbp(
  usd: number | null | undefined,
  rate = parseFloat(process.env.PRICE_USD_TO_GBP ?? process.env.NEXT_PUBLIC_USD_TO_GBP ?? '0.79') || 0.79
): number | null {
  if (usd == null) return null
  return Math.round(usd * rate * 100)
}

export function eurToGbp(
  eur: number | null | undefined,
  rate = parseFloat(process.env.PRICE_EUR_TO_GBP ?? process.env.NEXT_PUBLIC_EUR_TO_GBP ?? '0.86') || 0.86
): number | null {
  if (eur == null) return null
  return Math.round(eur * rate * 100)
}

// A Cardmarket cache entry older than this is refreshed on demand when the
// buylist/search screens price the card (see lib/prices/sync.ts). Client-safe
// so the buylist page can decide when to request a refresh. In-stock cards are
// re-synced nightly; this only governs the rest of the catalogue.
export const CARDMARKET_STALE_MS = 7 * 24 * 3600 * 1000

export function isCardmarketFresh(syncedAt: string | null | undefined, now = Date.now()): boolean {
  if (!syncedAt) return false
  const t = Date.parse(syncedAt)
  return Number.isFinite(t) && now - t < CARDMARKET_STALE_MS
}

// Pick the "market" price that drives sell-price math, per shop setting.
// Both inputs are already GBP pence. Falls back to the other source if the chosen one is missing.
export function pickMarketPrice(
  prices: { tcgplayerMarket?: number | null; cardmarketTrend?: number | null } | null | undefined,
  source: 'cardmarket' | 'tcgplayer'
): number | null {
  if (!prices) return null
  const cm = prices.cardmarketTrend ?? null
  const tcg = prices.tcgplayerMarket ?? null
  return source === 'cardmarket' ? (cm ?? tcg) : (tcg ?? cm)
}

// Standard UK VAT rate. Single source of truth so a rate change is one edit.
export const VAT_RATE = 0.2
// Margin VAT is VAT-inclusive: the VAT inside a gross amount is amount × rate/(1+rate).
// MARGIN_VAT_DIVISOR is derived from VAT_RATE to stay exact and avoid rounding artifacts.
export const MARGIN_VAT_DIVISOR = Math.round((1 + VAT_RATE) / VAT_RATE)

// Single source of truth for the CUSTOMER total — used by createSale (canonical)
// and the checkout UI (so the client's expectedTotal always agrees with the
// server). The client never needs cost data: under the margin scheme VAT is
// inclusive, so the total is identical to 'none'. Standard VAT is added on top.
// Discount is clamped to [0, subtotal].
export function computeSaleTotals(
  subtotalPence: number,
  discountPence: number,
  vatScheme: 'none' | 'standard' | 'margin',
): { discount: number; vatAmount: number; total: number } {
  const discount = Math.min(Math.max(0, discountPence), subtotalPence)
  const afterDiscount = subtotalPence - discount
  const vatAmount = vatScheme === 'standard' ? Math.round(afterDiscount * VAT_RATE) : 0
  return { discount, vatAmount, total: afterDiscount + vatAmount }
}

// Server-ONLY. Computes the VAT owed to HMRC on the margin of each sale line,
// for the VAT Margin Scheme (second-hand goods). VAT is inclusive, so this does
// NOT change the customer total (see computeSaleTotals). Must never be imported
// by a client component — it takes cost data, which stays out of the browser.
//
// - Discount is spread across lines in proportion to line value (largest-remainder
//   so integer pence allocations sum exactly to the discount).
// - Per line: margin = max(0, effectiveLineValue - cost×qty); VAT = round(margin/6).
//   Margins float at 0 per line — a loss on one card cannot offset another
//   (pooling is only allowed under HMRC's Global Accounting Scheme, not implemented).
// - Lines with no cost basis (costAtSale null) can't be in the scheme: they
//   contribute 0 VAT and are counted so the caller can warn/block.
export function computeMarginVat(
  lines: { unitPrice: number; quantity: number; costAtSale: number | null; standardRated?: boolean }[],
  discountPence: number,
): { vatAmount: number; noCostLineCount: number } {
  const values = lines.map(l => l.unitPrice * l.quantity)
  const subtotal = values.reduce((s, v) => s + v, 0)
  const discount = Math.min(Math.max(0, discountPence), subtotal)

  // Proportional allocation with largest-remainder distribution of leftover pence.
  const alloc = values.map(v => (subtotal > 0 ? Math.floor((discount * v) / subtotal) : 0))
  let remainder = discount - alloc.reduce((s, a) => s + a, 0)
  const byFraction = values
    .map((v, i) => ({ i, frac: subtotal > 0 ? (discount * v) % subtotal : 0 }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < byFraction.length && remainder > 0; k++) {
    alloc[byFraction[k].i]++
    remainder--
  }

  let vatAmount = 0
  let noCostLineCount = 0
  lines.forEach((l, i) => {
    const effLineValue = values[i] - alloc[i]
    // Standard-rated lines (new retail products) are never margin-scheme
    // goods: they owe inclusive VAT on the full effective value, and a
    // missing cost basis is irrelevant to the scheme.
    if (l.standardRated) { vatAmount += Math.round(effLineValue / MARGIN_VAT_DIVISOR); return }
    if (l.costAtSale == null) { noCostLineCount++; return }
    const margin = Math.max(0, effLineValue - l.costAtSale * l.quantity)
    vatAmount += Math.round(margin / MARGIN_VAT_DIVISOR)
  })
  return { vatAmount, noCostLineCount }
}

