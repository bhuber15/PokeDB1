import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { buyTransactions } from '@/lib/db/schema'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createBuy } from '@/lib/domain/buys'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
    method: 'cash' | 'store_credit'
    customerId?: number
  }
  const result = await createBuy({
    staffId: session.staffId,
    items: body.items ?? [],
    method: body.method,
    customerId: body.customerId,
  })
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  requireStaff(await getSession())
  const rows = await db.select().from(buyTransactions).orderBy(desc(buyTransactions.createdAt)).limit(50)
  return NextResponse.json(rows)
})
