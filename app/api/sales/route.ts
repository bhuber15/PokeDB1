// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { sales } from '@/lib/db/schema'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { createSale } from '@/lib/domain/sales'

const paymentMethodEnum = z.enum(['cash', 'card', 'store_credit', 'other'])

const createSaleBody = z.object({
  items: z.array(z.object({
    inventoryItemId: z.number().int(),
    quantity: z.number().int(),
  })).default([]),
  // Exactly one of paymentMethod (single tender — also the shape old queued
  // offline sales replay with) or payments (split tender). createSale
  // enforces the XOR and the sum-to-total rule.
  paymentMethod: paymentMethodEnum.optional(),
  payments: z.array(z.object({
    method: paymentMethodEnum,
    amount: z.number().int().positive(), // pence
  })).max(4).optional(),
  discountAmount: z.number().int().nonnegative().optional(), // pence
  customerId: z.number().int().optional(),
  expectedTotal: z.number().int(), // pence
  clientUuid: z.string().uuid().optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))
  const body = await parseBody(req, createSaleBody)
  const result = await createSale({
    staffId: session.staffId,
    items: body.items,
    paymentMethod: body.paymentMethod,
    payments: body.payments,
    discount: body.discountAmount ?? 0,
    customerId: body.customerId,
    expectedTotal: body.expectedTotal,
    clientUuid: body.clientUuid,
  }, db)
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(50)
  return NextResponse.json(rows)
})
