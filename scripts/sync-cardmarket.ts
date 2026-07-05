import './load-env'
import { db } from '../lib/db'
import { cards } from '../lib/db/schema'
import { getSettings } from '../lib/settings'
import { syncCardmarketForCard } from '../lib/prices/sync'

async function main() {
  const settings = await getSettings()
  const all = await db.select().from(cards)
  let ok = 0
  for (const c of all) {
    await syncCardmarketForCard(c.id, c.externalId, c.variant, settings.eurToGbp)
    ok++
    if (ok % 25 === 0) console.log(`synced ${ok}/${all.length}`)
    await new Promise(r => setTimeout(r, 120)) // be gentle on the free API
  }
  console.log(`done: ${ok}/${all.length}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
