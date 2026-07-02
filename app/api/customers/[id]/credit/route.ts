import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { creditLedger, customers } from '@/lib/db/schema'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCustomerBalance } from '@/lib/credit'

export const POST = guarded(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const session = requireAdmin(await getSession())
  const customerId = parseInt((await params).id)
  const { delta } = await req.json()
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return NextResponse.json({ error: 'Invalid delta' }, { status: 400 })
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1)
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await db.insert(creditLedger).values({
    customerId, delta: Math.round(n * 100) / 100, reason: 'adjustment',
    staffId: session.staffId ?? null,
  })
  return NextResponse.json({ balance: await getCustomerBalance(customerId) })
})
