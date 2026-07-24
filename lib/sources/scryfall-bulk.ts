import { db, type Db } from '@/lib/db'
import { fetchScryfallBulkUri, normalizeScryfallCard, type ScryfallCard } from '@/lib/apis/scryfall'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface ScryfallBulkDeps {
  // Async stream of raw card objects; defaults to streaming the live bulk file.
  stream?: () => AsyncIterable<ScryfallCard>
}

// Stream Scryfall's default_cards bulk file (557 MB) object-by-object, so peak
// memory stays flat. Used only by the off-cron import script.
async function* streamBulk(): AsyncIterable<ScryfallCard> {
  // stream-json 3.x: the bare parser()/streamArray() calls return "core"
  // stream-chain flushables (no .pipe()) — the Node-Duplex wrapper is the
  // separate .asStream() adapter attached to the same factory.
  const { parser } = await import('stream-json')
  const { streamArray } = await import('stream-json/streamers/stream-array.js')
  const uri = await fetchScryfallBulkUri()
  const res = await fetch(uri, { headers: { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)' } })
  if (!res.ok || !res.body) throw new Error(`Scryfall bulk download ${res.status}`)
  const { Readable } = await import('node:stream')
  const pipeline = Readable.fromWeb(res.body as never).pipe(parser.asStream()).pipe(streamArray.asStream())
  for await (const { value } of pipeline as AsyncIterable<{ value: ScryfallCard }>) yield value
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
