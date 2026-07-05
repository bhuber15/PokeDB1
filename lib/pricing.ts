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

// Single source of truth for sale arithmetic — used by createSale (canonical)
// and the checkout UI (so the client's expectedTotal always agrees with the
// server). Discount is clamped to [0, subtotal]; standard VAT is 20% on the
// discounted amount, rounded to the nearest pence.
export function computeSaleTotals(
  subtotalPence: number,
  discountPence: number,
  vatScheme: 'none' | 'standard',
): { discount: number; vatAmount: number; total: number } {
  const discount = Math.min(Math.max(0, discountPence), subtotalPence)
  const afterDiscount = subtotalPence - discount
  const vatAmount = vatScheme === 'standard' ? Math.round(afterDiscount * 0.2) : 0
  return { discount, vatAmount, total: afterDiscount + vatAmount }
}
