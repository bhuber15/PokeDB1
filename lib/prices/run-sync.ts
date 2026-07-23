import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import type { Db } from '@/lib/db'

interface RunSyncDeps {
  sweepTcgplayer?: typeof sweepTcgplayerCatalogue
  sweepTcgdex?: typeof sweepTcgdexCatalogue
  syncInStock?: typeof syncInStockCardmarket
  syncStale?: typeof syncStaleCardmarket
  prune?: typeof pruneOldHistory
}

// One tenant's full nightly refresh. EN catalogue sweep, then the TCGdex CJK
// catalogue sweep (new sets only after the initial import — cheap), then
// per-card in-stock sync, then the bounded stalest-first rotation (which now
// also covers CJK rows and backfills aliases), then history retention.
// Rotation runs after the in-stock sync so freshly synced stock sorts to the
// back of the rotation queue instead of being fetched twice.
export async function runFullPriceSync(db: Db, deps: RunSyncDeps = {}) {
  const settings = await getSettings(db)
  const sweep = await (deps.sweepTcgplayer ?? sweepTcgplayerCatalogue)(settings, {}, db)
  const tcgdexSweep = await (deps.sweepTcgdex ?? sweepTcgdexCatalogue)(settings, db)
  const cardmarket = await (deps.syncInStock ?? syncInStockCardmarket)(settings, db)
  const cardmarketRotation = await (deps.syncStale ?? syncStaleCardmarket)(settings, {}, db)
  await (deps.prune ?? pruneOldHistory)(db)
  return { sweep, tcgdexSweep, cardmarket, cardmarketRotation }
}
