import './load-env'
import { db } from '../lib/db'
import { cards } from '../lib/db/schema'
import { getSettings } from '../lib/settings'
import { syncMarketPricesForCard } from '../lib/prices/sync'

async function main() {
  const settings = await getSettings()
  const all = await db.select().from(cards)
  let ok = 0
  let failed = 0
  for (const c of all) {
    try {
      await syncMarketPricesForCard(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp })
      ok++
    } catch {
      failed++ // transient TCGdex failure — keep sweeping; the nightly rotation retries
    }
    if ((ok + failed) % 25 === 0) console.log(`synced ${ok}/${all.length}${failed ? ` (${failed} failed)` : ''}`)
    await new Promise(r => setTimeout(r, 120)) // be gentle on the free API
  }
  console.log(`done: ${ok}/${all.length}${failed ? ` (${failed} failed)` : ''}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
