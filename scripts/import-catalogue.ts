// One-time full-catalogue import (and safe to re-run any time — it is the
// same idempotent sweep the nightly cron uses).
//   npx tsx scripts/import-catalogue.ts
import { getSettings } from '../lib/settings'
import { sweepTcgplayerCatalogue } from '../lib/prices/sync'

async function main() {
  const settings = await getSettings()
  console.log(`Sweeping full catalogue (threshold £${(settings.highValueThreshold / 100).toFixed(2)}, USD rate ${settings.usdToGbp})…`)
  const result = await sweepTcgplayerCatalogue(settings, {}, undefined, (page, r) => {
    console.log(`page ${page}: ${r.cardsSeen} cards seen, ${r.newCards} new, ${r.pricesUpdated} prices updated, ${r.pagesFailed} failed pages`)
  })
  console.log('Done:', result)
  if (result.pagesFailed > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
