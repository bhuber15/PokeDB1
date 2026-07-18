import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import type { Db } from '@/lib/db'

// One tenant's full nightly refresh. Full-catalogue TCGplayer sweep (also
// picks up newly released sets), then per-card Cardmarket for in-stock, then
// a bounded stalest-first Cardmarket rotation over the rest of the catalogue
// (so buylist offers for unstocked cards aren't left on the USD fallback),
// then history retention. Rotation runs after the in-stock sync so freshly
// synced stock sorts to the back of the rotation queue instead of being
// fetched twice.
export async function runFullPriceSync(db: Db) {
  const settings = await getSettings(db)
  const sweep = await sweepTcgplayerCatalogue(settings, {}, db)
  const cardmarket = await syncInStockCardmarket(settings, db)
  const cardmarketRotation = await syncStaleCardmarket(settings, {}, db)
  await pruneOldHistory(db)
  return { sweep, cardmarket, cardmarketRotation }
}
