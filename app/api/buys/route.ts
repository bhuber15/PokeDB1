import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { buyTransactions } from '@/lib/db/schema'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { createBuy } from '@/lib/domain/buys'

const createBuyBody = z.object({
  items: z.array(z.object({
    cardId: z.number().int(),
    condition: z.string(),
    quantity: z.number().int(),
    payPrice: z.number(),
  })).default([]),
  method: z.enum(['cash', 'store_credit']),
  customerId: z.number().int().optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await parseBody(req, createBuyBody)
  const result = await createBuy({
    staffId: session.staffId,
    items: body.items,
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
