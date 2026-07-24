import { db, type Db } from '@/lib/db'
import { fetchYgoprodeckDump, normalizeYgoCard } from '@/lib/apis/ygoprodeck'
import { chunked } from '@/lib/prices/sync'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface YgoSweepDeps { fetchDump?: typeof fetchYgoprodeckDump }

// The whole Yu-Gi-Oh! catalogue in one call, upserted per printing. Cheap
// enough to run in full each night, so no cursor. Skips unless enabled.
export async function sweepYgoprodeck(
  settings: AppSettings, dbc: Db = db, deps: YgoSweepDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('yugioh')) return result
  let dump
  try {
    dump = await (deps.fetchDump ?? fetchYgoprodeckDump)()
  } catch {
    result.failed++
    return result
  }
  const rows = dump.flatMap(normalizeYgoCard)
  // Upsert in card-sized batches so one huge multi-row statement never trips
  // SQLite's variable limit (upsertNormalizedCards re-chunks to 100 anyway).
  for (const batch of chunked(rows, 500)) {
    await upsertNormalizedCards(dbc, batch, settings, result)
  }
  return result
}
