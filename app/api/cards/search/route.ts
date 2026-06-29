import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { or, like, eq } from 'drizzle-orm'
import { searchPokemonCards, extractBestPrice } from '@/lib/apis/pokemon-tcg'
import { getSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  const existing = await db.select().from(cards)
    .where(or(like(cards.name, `%${q}%`), like(cards.setNumber, `%${q}%`)))
    .limit(20)

  if (existing.length > 0) return NextResponse.json({ cards: existing })

  // Cache miss — fetch from API
  const apiCards = await searchPokemonCards(q)
  if (apiCards.length === 0) return NextResponse.json({ cards: [] })

  const threshold = parseFloat(process.env.HIGH_VALUE_THRESHOLD ?? '50')

  const inserted = (await Promise.all(apiCards.map(async apiCard => {
    // Explicit pre-insert check — externalId has no unique constraint so onConflictDoNothing would be a silent no-op
    const existing = await db.select().from(cards).where(eq(cards.externalId, apiCard.id)).limit(1)
    if (existing.length > 0) return existing[0]

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
      const p = extractBestPrice(apiCard)
      await db.insert(priceCache).values({
        cardId: card.id,
        tcgplayerMarket: p.market,
        tcgplayerLow: p.low,
        tcgplayerMid: p.mid,
        tcgplayerHigh: p.high,
        isHighValue: (p.market ?? 0) >= threshold,
      })
      return card
    }
    return null
  }))).filter(Boolean)

  return NextResponse.json({ cards: inserted })
}
