// One-time full-catalogue import (and safe to re-run any time — it is the
// same idempotent sweep the nightly cron uses).
//   npx tsx scripts/import-catalogue.ts
//   npx tsx scripts/import-catalogue.ts --only=mtg,yugioh
import './load-env'
import { getSettings } from '../lib/settings'
import { sweepTcgplayerCatalogue } from '../lib/prices/sync'
import { sweepTcgdexCatalogue } from '../lib/prices/tcgdex-sweep'
import { syncStaleCardmarket } from '../lib/prices/sync'
import { importScryfallBulk } from '../lib/sources/scryfall-bulk'
import { sweepYgoprodeck } from '../lib/sources/ygoprodeck-sweep'
import { GAME_IDS, isGame, type Game } from '../lib/games'

// --only=mtg,yugioh restricts the run to those games. Turning a new game on in
// an existing shop otherwise re-sweeps the whole Pokémon catalogue — thousands
// of paged API calls — before it gets to the game you actually added.
function parseOnly(argv: string[]): Game[] | null {
  const arg = argv.find(a => a.startsWith('--only='))
  if (!arg) return null
  const names = arg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)
  const unknown = names.filter(n => !isGame(n))
  if (unknown.length > 0) {
    throw new Error(`--only: unknown game(s) ${unknown.join(', ')}. Known: ${GAME_IDS.join(', ')}`)
  }
  if (names.length === 0) throw new Error('--only needs at least one game')
  return names.filter(isGame)
}

async function main() {
  const settings = await getSettings()
  const only = parseOnly(process.argv)
  const wanted = (game: Game) => only === null || only.includes(game)
  if (only) console.log(`Limiting this run to: ${only.join(', ')}`)

  let pagesFailed = 0
  let setsFailed = 0

  if (wanted('pokemon')) {
    console.log(`Sweeping full catalogue (threshold £${(settings.highValueThreshold / 100).toFixed(2)}, USD rate ${settings.usdToGbp})…`)
    const result = await sweepTcgplayerCatalogue(settings, {}, undefined, (page, r) => {
      console.log(`page ${page}: ${r.cardsSeen} cards seen, ${r.newCards} new, ${r.pricesUpdated} prices updated, ${r.pagesFailed} failed pages`)
    })
    console.log('Done:', result)
    pagesFailed = result.pagesFailed

    const cjk = await sweepTcgdexCatalogue(settings, undefined, {}, (setId, r) => {
      console.log(`tcgdex ${setId}: ${r.cardsSeen} cards seen, ${r.newCards} new, ${r.setsFailed} failed sets`)
    })
    console.log('TCGdex sweep done:', cjk)
    setsFailed = cjk.setsFailed
  }

  if (wanted('mtg') && settings.enabledGames.includes('mtg')) {
    const mtg = await importScryfallBulk(settings)
    console.log('Scryfall (MTG) import done:', mtg)
    if (mtg.failed > 0) process.exitCode = 1
  }
  if (wanted('yugioh') && settings.enabledGames.includes('yugioh')) {
    const ygo = await sweepYgoprodeck(settings)
    console.log('YGOPRODeck import done:', ygo)
    if (ygo.failed > 0) process.exitCode = 1
  }

  // --full-prices: run the per-card rotation to completion now (prices where
  // TCGdex has them + alias_name backfill) instead of trickling ~2,000/night.
  // A full CJK catalogue is tens of thousands of per-card fetches — expect
  // this to run for a while; it is safe to interrupt and re-run.
  if (process.argv.includes('--full-prices')) {
    let pass = 1
    for (;;) {
      const r = await syncStaleCardmarket(settings, { limit: 5000, timeBudgetMs: 10 * 60_000 })
      console.log(`rotation pass ${pass++}: synced ${r.synced}, failed ${r.failed}, remaining ${r.remaining}`)
      // Stop when a pass makes no progress: either the stale query returned
      // nothing (backfill complete — synced cards age out of the candidate
      // pool via their fresh cardmarketSyncedAt stamp), or everything left is
      // persistently failing (retrying forever would hang the script; failures
      // stay stale and are retried by the nightly rotation). `remaining` is
      // NOT a completion signal here — it counts only the current pass's
      // limit-capped candidate set.
      if (r.synced === 0) break
    }
  }
  if (pagesFailed > 0 || setsFailed > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
