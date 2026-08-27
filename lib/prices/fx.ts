import { db, type Db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/settings'
import { fetchEcbGbpRates } from '@/lib/apis/frankfurter'

export interface FxRefreshResult {
  updated: boolean
  usd: number
  eur: number
  error?: string
}

// Nightly step 0: write today's ECB reference rates into the shop's
// usdToGbp/eurToGbp settings, so that night's conversions — and every sell/buy
// price until the next run — use a live rate instead of a hand-typed one.
// Fails soft by design: any fetch problem keeps the stored rates (the owner's
// value, or the last successful refresh) and reports the reason, so a dead FX
// feed can never block the price sync. The PRICE_*_TO_GBP env rates remain
// only the seed for a brand-new settings row.
export async function refreshFxRates(
  dbc: Db = db,
  fetchRates: typeof fetchEcbGbpRates = fetchEcbGbpRates,
): Promise<FxRefreshResult> {
  const current = await getSettings(dbc)
  try {
    const { usd, eur } = await fetchRates()
    if (usd === current.usdToGbp && eur === current.eurToGbp) return { updated: false, usd, eur }
    await updateSettings({ usdToGbp: usd, eurToGbp: eur }, dbc)
    return { updated: true, usd, eur }
  } catch (e) {
    return {
      updated: false,
      usd: current.usdToGbp,
      eur: current.eurToGbp,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
