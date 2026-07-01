import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, creditLedger, wantList, cards } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { getCustomerBalance } from '@/lib/credit'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = parseInt((await params).id)
  const [customer] = await db.select().from(customers).where(eq(customers.id, id))
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const [balance, ledger, wants] = await Promise.all([
    getCustomerBalance(id),
    db.select().from(creditLedger).where(eq(creditLedger.customerId, id)).orderBy(desc(creditLedger.createdAt)).limit(50),
    db.select({
      id: wantList.id,
      customerId: wantList.customerId,
      cardId: wantList.cardId,
      freeText: wantList.freeText,
      notify: wantList.notify,
      createdAt: wantList.createdAt,
      fulfilledAt: wantList.fulfilledAt,
      cardName: cards.name,
      cardSetName: cards.setName,
      cardSetNumber: cards.setNumber,
    }).from(wantList).leftJoin(cards, eq(wantList.cardId, cards.id)).where(eq(wantList.customerId, id)),
  ])
  return NextResponse.json({ customer, balance, ledger, wants })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = parseInt((await params).id)
  const body = await req.json()
  const updates = Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'phone', 'email', 'notes'].includes(k)))
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 })
  const [updated] = await db.update(customers).set(updates).where(eq(customers.id, id)).returning()
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
}
