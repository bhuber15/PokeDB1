export function calculateSellPrice(
  marketPrice: number | null | undefined,
  override: number | null | undefined,
  multiplier = parseFloat(process.env.NEXT_PUBLIC_MARGIN_MULTIPLIER ?? '0.85') || 0.85
): number | null {
  if (override != null) return override
  if (marketPrice == null) return null
  return Math.ceil(marketPrice * multiplier * 100) / 100
}

export function formatGBP(amount: number | null | undefined): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount)
}

// Buy-in offer = market price × percentage, floored so we never overpay by a rounding penny.
// Pure (no DB) so client components can import it safely.
export function calculateBuyPrice(market: number | null | undefined, pct: number): number | null {
  if (market == null) return null
  return Math.floor(market * pct * 100) / 100
}

// Pokemon TCG API returns prices in USD. Convert to GBP at a configurable rate.
// Pass the rate from shop settings; falls back to env, then 0.79.
export function usdToGbp(
  usd: number | null | undefined,
  rate = parseFloat(process.env.PRICE_USD_TO_GBP ?? process.env.NEXT_PUBLIC_USD_TO_GBP ?? '0.79') || 0.79
): number | null {
  if (usd == null) return null
  return Math.round(usd * rate * 100) / 100
}
