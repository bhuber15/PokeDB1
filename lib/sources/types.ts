import type { Game, Language } from '@/lib/games'

// Native-currency prices from an upstream. Single market number per family —
// Scryfall and YGOPRODeck each quote one figure (no low/mid/high). The sync
// layer converts to GBP pence at the shop's rates. Emit null, never 0.
export interface NormalizedPrices {
  tcgplayerUsd: number | null // → price_cache.tcgplayer_market
  cardmarketEur: number | null // → price_cache.cardmarket_trend
}

// One catalogue row plus its prices, source-agnostic. `variant` follows the
// existing cards.variant convention: '' means the plain/base printing.
export interface NormalizedCard {
  game: Game
  language: Language
  name: string
  setName: string
  setNumber: string
  variant: string
  series: string | null
  externalId: string
  imageUrl: string | null
  imageUrlLarge: string | null
  prices: NormalizedPrices
}
