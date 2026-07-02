import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { customers, creditLedger, wantList, cards } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getCustomerBalance } from '@/lib/credit'

const patchCustomerBody = z.object({
  name: z.string().trim().min(1).optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

export const GET = guarded(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  requireStaff(await getSession())
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
})

export const PATCH = guarded(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  requireStaff(await getSession())
  const id = parseInt((await params).id)
  const body = await parseBody(req, patchCustomerBody)
  const updates = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 })
  const [updated] = await db.update(customers).set(updates).where(eq(customers.id, id)).returning()
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
})
