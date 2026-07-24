import { eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { catalogueSyncState } from '@/lib/db/schema'
import { fetchScryfallPage, normalizeScryfallCard } from '@/lib/apis/scryfall'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export const SCRYFALL_MAX_PAGES = 40 // ~175 cards/page; full ~100k catalogue cycles ~2 weeks

export interface ScryfallSweepDeps { fetchPage?: typeof fetchScryfallPage }

async function readCursor(dbc: Db): Promise<number> {
  const [row] = await dbc.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  const n = row?.cursor ? parseInt(row.cursor, 10) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

async function writeCursor(dbc: Db, page: number): Promise<void> {
  await dbc.insert(catalogueSyncState).values({ game: 'mtg', cursor: String(page), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: catalogueSyncState.game, set: { cursor: String(page), updatedAt: new Date().toISOString() } })
}

// Bounded, cursored crawl of Scryfall's paged catalogue. Resumes at the stored
// page, imports up to `maxPages`, and persists where to resume next run — so
// nightly MTG work is capped regardless of catalogue size. Wraps to page 1 at
// the end so the whole catalogue re-prices over successive nights. Skips
// entirely unless MTG is enabled.
export async function sweepScryfall(
  settings: AppSettings, dbc: Db = db, opts: { maxPages?: number } = {}, deps: ScryfallSweepDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('mtg')) return result
  const fetchPage = deps.fetchPage ?? fetchScryfallPage
  const maxPages = opts.maxPages ?? SCRYFALL_MAX_PAGES

  let page = await readCursor(dbc)
  for (let i = 0; i < maxPages; i++) {
    let batch
    try {
      batch = await fetchPage(page)
    } catch {
      result.failed++
      break // upstream hiccup — keep the cursor, retry next run
    }
    const rows = batch.cards.flatMap(normalizeScryfallCard)
    await upsertNormalizedCards(dbc, rows, settings, result)
    if (!batch.hasMore) { page = 1; break } // wrapped
    page++
  }
  await writeCursor(dbc, page)
  return result
}
