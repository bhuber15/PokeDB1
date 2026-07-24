import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import type { Db } from '@/lib/db'

interface RunSyncDeps {
  sweepTcgplayer?: typeof sweepTcgplayerCatalogue
  sweepTcgdex?: typeof sweepTcgdexCatalogue
  sweepScryfall?: typeof sweepScryfall
  sweepYgo?: typeof sweepYgoprodeck
  syncInStock?: typeof syncInStockCardmarket
  syncStale?: typeof syncStaleCardmarket
  prune?: typeof pruneOldHistory
}

// One tenant's full nightly refresh. Pokémon EN + CJK sweeps first (unchanged),
// then the other enabled games' catalogue sweeps (each internally a no-op when
// its game is disabled, and each self-bounded: MTG is page-budgeted/cursored,
// YGO is a single cheap call), then per-card in-stock sync, the stalest-first
// rotation, and history retention. Every sweep is independent, so a failing
// upstream for one game never blocks another.
export async function runFullPriceSync(db: Db, deps: RunSyncDeps = {}) {
  const settings = await getSettings(db)
  const sweep = await (deps.sweepTcgplayer ?? sweepTcgplayerCatalogue)(settings, {}, db)
  const tcgdexSweep = await (deps.sweepTcgdex ?? sweepTcgdexCatalogue)(settings, db)
  const scryfallSweep = await (deps.sweepScryfall ?? sweepScryfall)(settings, db)
  const ygoSweep = await (deps.sweepYgo ?? sweepYgoprodeck)(settings, db)
  const cardmarket = await (deps.syncInStock ?? syncInStockCardmarket)(settings, db)
  const cardmarketRotation = await (deps.syncStale ?? syncStaleCardmarket)(settings, {}, db)
  await (deps.prune ?? pruneOldHistory)(db)
  return { sweep, tcgdexSweep, scryfallSweep, ygoSweep, cardmarket, cardmarketRotation }
}
