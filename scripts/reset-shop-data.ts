// Wipes all shop data for a fresh start: inventory, sales, refunds, buys,
// credit ledger, want list, and the entire card catalogue (including the
// corrupted seed rows). Keeps staff and settings; keeps customers unless
// --customers is passed. Run scripts/import-catalogue.ts afterwards to
// rebuild a clean catalogue.
//
// Preview counts:   npx tsx scripts/reset-shop-data.ts
// Actually wipe:    npx tsx scripts/reset-shop-data.ts --yes [--customers]
import './load-env'
import { db } from '../lib/db'
import {
  refundItems, refunds, saleItems, sales, buyItems, buyTransactions,
  creditLedger, wantList, inventoryItems, priceHistory, priceCache, cards, customers,
} from '../lib/db/schema'

const YES = process.argv.includes('--yes')
const WIPE_CUSTOMERS = process.argv.includes('--customers')

// FK-safe order: children before parents
const TABLES = [
  ['refund_items', refundItems],
  ['refunds', refunds],
  ['sale_items', saleItems],
  ['sales', sales],
  ['buy_items', buyItems],
  ['buy_transactions', buyTransactions],
  ['credit_ledger', creditLedger],
  ['want_list', wantList],
  ['inventory_items', inventoryItems],
  ['price_history', priceHistory],
  ['price_cache', priceCache],
  ['cards', cards],
  ...(WIPE_CUSTOMERS ? [['customers', customers] as const] : []),
] as const

async function main() {
  console.log(YES ? 'WIPING shop data…\n' : 'DRY RUN — row counts only (add --yes to wipe):\n')
  for (const [name, table] of TABLES) {
    const rows = await db.select().from(table)
    if (YES) {
      await db.delete(table)
      console.log(`wiped ${name} (${rows.length} rows)`)
    } else {
      console.log(`${name}: ${rows.length} rows would be deleted`)
    }
  }
  console.log(`\n${YES
    ? 'Done. Staff + settings kept' + (WIPE_CUSTOMERS ? '' : ' (customers kept too)') + '. Now run: npx tsx scripts/import-catalogue.ts'
    : 'Nothing deleted. Re-run with --yes to wipe' + (WIPE_CUSTOMERS ? '' : ' (add --customers to wipe customers too)')}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
