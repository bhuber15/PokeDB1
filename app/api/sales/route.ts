// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { sales } from '@/lib/db/schema'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { createSale } from '@/lib/domain/sales'

const createSaleBody = z.object({
  items: z.array(z.object({
    inventoryItemId: z.number().int(),
    quantity: z.number().int(),
  })).default([]),
  paymentMethod: z.enum(['cash', 'card', 'store_credit', 'other']),
  discountAmount: z.number().int().nonnegative().optional(), // pence
  customerId: z.number().int().optional(),
  expectedTotal: z.number().int(), // pence
  clientUuid: z.string().uuid().optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await parseBody(req, createSaleBody)
  const result = await createSale({
    staffId: session.staffId,
    items: body.items,
    paymentMethod: body.paymentMethod,
    discount: body.discountAmount ?? 0,
    customerId: body.customerId,
    expectedTotal: body.expectedTotal,
    clientUuid: body.clientUuid,
  })
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  requireAdmin(await getSession())
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(50)
  return NextResponse.json(rows)
})
