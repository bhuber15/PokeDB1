import { db, type Db } from '@/lib/db'
import { fetchLorcastSets, fetchLorcastSetCards, normalizeLorcastCard } from '@/lib/apis/lorcast'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface LorcastSweepDeps {
  fetchSets?: typeof fetchLorcastSets
  fetchSetCards?: typeof fetchLorcastSetCards
  gateMs?: number
}

// ~20 sets, one request each — YGO-class small, so the whole catalogue
// re-upserts every night with no cursor. Requests are serialised behind a
// polite gate (Lorcast documents 50–100ms between calls; 429 → IP bans).
// One failing set increments `failed` and the rest still land.
export async function sweepLorcast(
  settings: AppSettings, dbc: Db = db, deps: LorcastSweepDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('lorcana')) return result
  let sets
  try {
    sets = await (deps.fetchSets ?? fetchLorcastSets)()
  } catch {
    result.failed++
    return result
  }
  const gateMs = deps.gateMs ?? 100
  for (const set of sets) {
    if (!set.code) continue
    try {
      const setCards = await (deps.fetchSetCards ?? fetchLorcastSetCards)(set.code)
      await upsertNormalizedCards(dbc, setCards.flatMap(normalizeLorcastCard), settings, result)
    } catch {
      result.failed++
    }
    if (gateMs > 0) await new Promise(r => setTimeout(r, gateMs))
  }
  return result
}
