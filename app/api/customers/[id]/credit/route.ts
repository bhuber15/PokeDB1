import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { creditLedger, customers } from '@/lib/db/schema'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { getCustomerBalance } from '@/lib/credit'

const creditAdjustmentBody = z.object({
  delta: z.number().int().refine(n => n !== 0, 'Invalid delta'), // pence
})

export const POST = guarded(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const session = requireAdmin(await getSession())
  const customerId = parseIdParam((await params).id)
  const { delta: n } = await parseBody(req, creditAdjustmentBody)
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1)
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await db.insert(creditLedger).values({
    customerId, delta: n, reason: 'adjustment',
    staffId: session.staffId ?? null,
  })
  return NextResponse.json({ balance: await getCustomerBalance(customerId) })
})
