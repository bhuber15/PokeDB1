import './load-env'
import { db } from '../lib/db'
import { inventoryItems } from '../lib/db/schema'
import { eq } from 'drizzle-orm'


// One-time: collapse duplicate ACTIVE inventory rows for the same card+condition
// into a single survivor row (sum quantity, weighted-average cost). The extra rows
// are deactivated and zeroed rather than deleted, so historical sale_items/buy_items
// that reference them stay valid.
async function main() {
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.isActive, true))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.cardId ?? 'x'}|${r.condition}`
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }

  let merged = 0
  let deactivated = 0
  for (const [key, items] of groups) {
    if (items.length < 2) continue
    items.sort((a, b) => a.id - b.id)
    const survivor = items[0]
    const totalQty = items.reduce((s, i) => s + i.quantity, 0)
    const costSum = items.reduce((s, i) => s + i.costPrice * i.quantity, 0)
    const newCost = totalQty > 0 ? Math.round(costSum / totalQty) : survivor.costPrice // pence

    await db.update(inventoryItems)
      .set({ quantity: totalQty, costPrice: newCost })
      .where(eq(inventoryItems.id, survivor.id))

    for (const extra of items.slice(1)) {
      await db.update(inventoryItems)
        .set({ isActive: false, quantity: 0 })
        .where(eq(inventoryItems.id, extra.id))
      deactivated++
    }
    merged++
    console.log(`merged ${key}: ${items.length} rows → qty ${totalQty}, cost ${newCost}`)
  }

  console.log(`Done: ${merged} card+condition groups merged, ${deactivated} duplicate rows deactivated.`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
