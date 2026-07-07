import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseIdParam } from '@/lib/validation'

export const GET = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireStaff(await getSession())

  const id = parseIdParam((await params).id)
  const [card] = await db.select().from(cards).where(eq(cards.id, id))
  if (!card) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [prices] = await db.select().from(priceCache).where(eq(priceCache.cardId, card.id))
  return NextResponse.json({ ...card, priceCache: prices ?? null })
})
