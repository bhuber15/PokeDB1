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
