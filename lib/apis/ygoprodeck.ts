import { ygoExternalId } from '@/lib/sources/external-id'
import type { NormalizedCard } from '@/lib/sources/types'

const URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
const HEADERS = { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)' }
export const YGO_TIMEOUT_MS = 30_000 // the whole-game dump is a few MB

export class YgoprodeckError extends Error {}

interface YgoSet { set_name: string; set_code: string; set_rarity: string; set_rarity_code: string; set_price: string }
interface YgoImage { image_url: string; image_url_small?: string }
interface YgoPrice { cardmarket_price?: string; tcgplayer_price?: string }

export interface YgoCard {
  id: number
  name: string
  type: string
  card_sets?: YgoSet[]
  card_images?: YgoImage[]
  card_prices?: YgoPrice[]
}

// The entire game in one call — all cards, each with every printing. Cheap
// enough (a few MB) to refresh fully every night.
export async function fetchYgoprodeckDump(): Promise<YgoCard[]> {
  let res: Response
  try {
    res = await fetch(URL, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(YGO_TIMEOUT_MS) })
  } catch (e) {
    throw new YgoprodeckError(`YGOPRODeck unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new YgoprodeckError(`YGOPRODeck ${res.status}`)
  const body = await res.json() as { data?: YgoCard[] }
  return body.data ?? []
}

const money = (v: string | undefined): number | null => {
  const n = v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// One NormalizedCard per printing (set × rarity). Priced from that printing's
// set_price (USD → tcgplayer). Cardmarket is left null: YGOPRODeck's only EUR
// figure is a per-card aggregate that would misprice rare printings.
export function normalizeYgoCard(card: YgoCard): NormalizedCard[] {
  const img = card.card_images?.[0]
  return (card.card_sets ?? [])
    .filter(s => s.set_code)
    .map(s => ({
      game: 'yugioh' as const,
      language: 'EN' as const,
      name: card.name,
      setName: s.set_name,
      setNumber: s.set_code,
      variant: s.set_rarity,
      series: s.set_name,
      externalId: ygoExternalId(String(card.id), s.set_code, s.set_rarity_code, s.set_rarity),
      imageUrl: img?.image_url_small ?? null,
      imageUrlLarge: img?.image_url ?? null,
      prices: { tcgplayerUsd: money(s.set_price), cardmarketEur: null },
    }))
}
