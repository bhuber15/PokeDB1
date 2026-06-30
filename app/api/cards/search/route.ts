import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { or, like, eq } from 'drizzle-orm'
import { searchPokemonCards, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { getSession } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { usdToGbp } from '@/lib/pricing'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  // DB query (existing cards) and API query (full catalogue) in parallel.
  // The API call is wrapped so that if the free API is slow/down/rate-limited,
  // search degrades to DB-only results instead of throwing a 500.
  const [dbCards, apiCards, settings] = await Promise.all([
    db.select().from(cards)
      .where(or(like(cards.name, `%${q}%`), like(cards.setNumber, `%${q}%`)))
      .limit(50),
    searchPokemonCards(q).catch(() => [] as PokemonTCGCard[]),
    getSettings(),
  ])

  const existingExternalIds = new Set(dbCards.map(c => c.externalId).filter(Boolean))

  // Insert API cards not yet in the DB so the add-to-inventory flow has a cardId.
  const newCards = (await Promise.all(
    apiCards
      .filter(apiCard => !existingExternalIds.has(apiCard.id))
      .map(apiCard => insertCardSafely(apiCard, settings.highValueThreshold, settings.usdToGbp))
  )).filter((c): c is typeof cards.$inferSelect => c != null)

  return NextResponse.json({ cards: [...dbCards, ...newCards] })
}

// Resilient insert: re-checks for an existing row (handles a race between the
// two parallel queries) and swallows unique-constraint violations from a
// concurrent insert, returning whatever row ends up in the DB.
async function insertCardSafely(apiCard: PokemonTCGCard, threshold: number, rate: number) {
  const [existing] = await db.select().from(cards).where(eq(cards.externalId, apiCard.id)).limit(1)
  if (existing) return existing

  try {
    const [card] = await db.insert(cards).values({
      name: apiCard.name,
      game: 'pokemon',
      setName: apiCard.set.name,
      setNumber: apiCard.number,
      variant: apiCard.subtypes?.join('/') ?? null,
      externalId: apiCard.id,
      imageUrl: apiCard.images.small,
      imageUrlLarge: apiCard.images.large,
    }).returning()

    if (card) {
      const p = extractBestPrice(apiCard) // USD from TCGplayer
      const market = usdToGbp(p.market, rate)
      try {
        await db.insert(priceCache).values({
          cardId: card.id,
          tcgplayerMarket: market,
          tcgplayerLow: usdToGbp(p.low, rate),
          tcgplayerMid: usdToGbp(p.mid, rate),
          tcgplayerHigh: usdToGbp(p.high, rate),
          isHighValue: (market ?? 0) >= threshold,
        })
      } catch {
        // priceCache.cardId is unique — a concurrent insert already wrote it. Fine.
      }
    }
    return card ?? null
  } catch {
    // Concurrent insert won the race (or unique violation). Return the existing row.
    const [row] = await db.select().from(cards).where(eq(cards.externalId, apiCard.id)).limit(1)
    return row ?? null
  }
}
