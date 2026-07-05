import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { or, like, eq, sql } from 'drizzle-orm'
import { searchPokemonCards, extractBestPrice, type PokemonTCGCard } from '@/lib/apis/pokemon-tcg'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getSettings } from '@/lib/settings'
import { usdToGbp } from '@/lib/pricing'
import { syncCardmarketForCard } from '@/lib/prices/sync'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  // Local catalogue first (instant, works offline). Ranked: exact name,
  // then name prefix, then substring/set-number match.
  const dbCards = await db.select().from(cards)
    .where(or(like(cards.name, `%${q}%`), like(cards.setNumber, `%${q}%`)))
    .orderBy(
      sql`CASE WHEN lower(${cards.name}) = lower(${q}) THEN 0 WHEN ${cards.name} LIKE ${q + '%'} THEN 1 ELSE 2 END`,
      cards.name,
    )
    .limit(50)
  if (dbCards.length > 0) return NextResponse.json({ cards: dbCards })

  // Nothing local — fall back to the live API (e.g. a set newer than the
  // last catalogue sweep) and lazily insert what it finds.
  const [apiCards, settings] = await Promise.all([
    searchPokemonCards(q).catch(() => [] as PokemonTCGCard[]),
    getSettings(),
  ])
  const newCards = (await Promise.all(
    apiCards.map(apiCard => insertCardSafely(apiCard, settings.highValueThreshold, settings.usdToGbp, settings.eurToGbp))
  )).filter((c): c is typeof cards.$inferSelect => c != null)

  return NextResponse.json({ cards: newCards })
})

// Resilient insert: re-checks for an existing row (handles a race between the
// two parallel queries) and swallows unique-constraint violations from a
// concurrent insert, returning whatever row ends up in the DB.
async function insertCardSafely(apiCard: PokemonTCGCard, threshold: number, rate: number, eurRate: number) {
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
        // Fire-and-forget: don't add a TCGdex round-trip to search latency.
        // Durable population is guaranteed by the nightly cron + backfill script.
        void syncCardmarketForCard(card.id, card.externalId, card.variant, eurRate).catch(() => {})
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
