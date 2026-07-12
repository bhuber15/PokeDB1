// app/api/refunds/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { createRefund } from '@/lib/domain/refunds'

const createRefundBody = z.object({
  saleId: z.number().int(),
  method: z.enum(['cash', 'store_credit']),
  reason: z.string().optional(),
  items: z.array(z.object({
    saleItemId: z.number().int(),
    quantity: z.number().int(),
  })).default([]),
  customerId: z.number().int().optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))
  const body = await parseBody(req, createRefundBody)
  const result = await createRefund({
    staffId: session.staffId,
    saleId: body.saleId,
    method: body.method,
    reason: body.reason,
    items: body.items,
    customerId: body.customerId,
  }, db)
  return NextResponse.json(result, { status: 201 })
})
