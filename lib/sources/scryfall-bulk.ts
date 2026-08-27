import { db, type Db } from '@/lib/db'
import { fetchScryfallBulkUri, normalizeScryfallCard, type ScryfallCard } from '@/lib/apis/scryfall'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface ScryfallBulkDeps {
  // Async stream of raw card objects; defaults to streaming the live bulk file.
  stream?: () => AsyncIterable<ScryfallCard>
}

// Stream Scryfall's default_cards bulk file object-by-object, so peak memory
// stays flat. Since 2026 the file is gzipped JSON Lines (~78 MB compressed),
// served as raw application/gzip — decompress explicitly, parse per line.
// Used only by the off-cron import script.
async function* streamBulk(): AsyncIterable<ScryfallCard> {
  const uri = await fetchScryfallBulkUri()
  const res = await fetch(uri, { headers: { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)' } })
  if (!res.ok || !res.body) throw new Error(`Scryfall bulk download ${res.status}`)
  const { createGunzip } = await import('node:zlib')
  const { Readable } = await import('node:stream')
  const { createInterface } = await import('node:readline')
  const lines = createInterface({
    input: Readable.fromWeb(res.body as never).pipe(createGunzip()),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line) as ScryfallCard
  }
}

// Full MTG import: every printing + prices in one streamed pass. Idempotent
// (shares upsertNormalizedCards). No-op unless MTG is enabled.
export async function importScryfallBulk(
  settings: AppSettings, dbc: Db = db, deps: ScryfallBulkDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('mtg')) return result
  const stream = deps.stream ?? streamBulk
  let buffer: ScryfallCard[] = []
  const flush = async () => { if (buffer.length) { await upsertNormalizedCards(dbc, buffer.flatMap(normalizeScryfallCard), settings, result); buffer = [] } }
  for await (const card of stream()) {
    buffer.push(card)
    if (buffer.length >= 500) await flush()
  }
  await flush()
  return result
}
