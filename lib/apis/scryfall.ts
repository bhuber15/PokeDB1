import { scryfallExternalId, type MtgFinish } from '@/lib/sources/external-id'
import type { NormalizedCard } from '@/lib/sources/types'

const BASE = 'https://api.scryfall.com'
// Scryfall 403s the default fetch UA and requires an explicit Accept header.
const HEADERS = { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)', Accept: 'application/json' }
export const SCRYFALL_TIMEOUT_MS = 10_000

export class ScryfallError extends Error {}

interface ScryfallImageUris { small?: string; normal?: string; large?: string }

export interface ScryfallCard {
  id: string
  name: string
  lang: string
  set: string
  set_name: string
  collector_number: string
  rarity?: string
  finishes: MtgFinish[]
  games: string[]
  digital?: boolean
  image_uris?: ScryfallImageUris
  card_faces?: { image_uris?: ScryfallImageUris }[]
  prices: {
    usd?: string | null; usd_foil?: string | null; usd_etched?: string | null
    eur?: string | null; eur_foil?: string | null; tix?: string | null
  }
}

// Scryfall asks for ~50–100 ms between requests (~10/s) and rate-limits
// abusers. Serialise every Scryfall call through a promise chain spaced 100 ms
// apart, so both the paged crawl AND the in-stock sync's 8-concurrent per-card
// fan-out stay under the limit without each caller having to know about it.
let scryfallGate: Promise<void> = Promise.resolve()
function throttle(): Promise<void> {
  const next = scryfallGate.then(() => new Promise<void>(r => setTimeout(r, 100)))
  scryfallGate = next
  return next
}

async function getJson<T>(url: string): Promise<T> {
  await throttle()
  let res: Response
  try {
    res = await fetch(url, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(SCRYFALL_TIMEOUT_MS) })
  } catch (e) {
    throw new ScryfallError(`Scryfall unreachable for ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new ScryfallError(`Scryfall ${res.status} for ${url}`)
  return await res.json() as T
}

// The download URI of the current `default_cards` bulk file (one object per
// English printing). Used only by the off-cron import script.
export async function fetchScryfallBulkUri(): Promise<string> {
  const data = await getJson<{ download_uri: string }>(`${BASE}/bulk-data/default-cards`)
  return data.download_uri
}

// One page (175 cards) of the paged catalogue crawl the nightly sweep walks.
// `game:paper lang:en unique:prints` == the default_cards EN contents.
// `order=released dir=asc` (oldest-first) is REQUIRED, not cosmetic: the
// persisted page cursor is only meaningful if page N is a stable slice
// night-to-night. Oldest-first keeps the crawled tail stable while new sets
// append at the end (picked up as the cursor reaches them; hot cards stay
// fresh via the in-stock/on-demand paths regardless).
export async function fetchScryfallPage(page: number): Promise<{ cards: ScryfallCard[]; hasMore: boolean }> {
  const params = new URLSearchParams({ q: 'game:paper lang:en', unique: 'prints', order: 'released', dir: 'asc', page: String(page) })
  try {
    const body = await getJson<{ data: ScryfallCard[]; has_more: boolean }>(`${BASE}/cards/search?${params}`)
    return { cards: body.data, hasMore: body.has_more }
  } catch (e) {
    // A search past the last page 404s — treat as a clean end, not an error.
    if (e instanceof ScryfallError && e.message.includes('404')) return { cards: [], hasMore: false }
    throw e
  }
}

// Scryfall emits 0/absent for prices it doesn't have — 0 is "no data".
const money = (v: string | null | undefined): number | null => {
  const n = v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const FINISH_VARIANT: Record<MtgFinish, string> = { nonfoil: '', foil: 'Foil', etched: 'Etched' }

function priceForFinish(prices: ScryfallCard['prices'], finish: MtgFinish): NormalizedCard['prices'] {
  if (finish === 'foil') return { tcgplayerUsd: money(prices.usd_foil), cardmarketEur: money(prices.eur_foil) }
  if (finish === 'etched') return { tcgplayerUsd: money(prices.usd_etched), cardmarketEur: null }
  return { tcgplayerUsd: money(prices.usd), cardmarketEur: money(prices.eur) }
}

// One NormalizedCard per paper finish. Non-paper (digital-only) cards drop out.
// Phase 2 is EN-only: the bulk file (Task 8) is default_cards, which includes a
// card's non-English printing when it has no English one — those must NOT be
// stored as language 'EN'. The paged sweep filters lang:en upstream; this guard
// covers the bulk-import path (and any future all_cards use).
export function normalizeScryfallCard(card: ScryfallCard): NormalizedCard[] {
  if (card.lang !== 'en') return []
  if (!card.games?.includes('paper')) return []
  const img = card.image_uris ?? card.card_faces?.[0]?.image_uris
  return card.finishes.map(finish => ({
    game: 'mtg' as const,
    language: 'EN' as const,
    name: card.name,
    setName: card.set_name,
    setNumber: card.collector_number,
    variant: FINISH_VARIANT[finish],
    series: card.set, // the set code (e.g. "2x2"); set_name holds the human name
    externalId: scryfallExternalId(card.id, finish),
    imageUrl: img?.small ?? null,
    imageUrlLarge: img?.large ?? null,
    prices: priceForFinish(card.prices, finish),
  }))
}
