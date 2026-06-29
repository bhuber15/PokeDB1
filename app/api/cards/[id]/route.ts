import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const [card] = await db.select().from(cards).where(eq(cards.id, parseInt(id)))
  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [prices] = await db.select().from(priceCache).where(eq(priceCache.cardId, card.id))
  return NextResponse.json({ ...card, priceCache: prices ?? null })
}
