// app/api/refunds/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createRefund } from '@/lib/domain/refunds'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    saleId: number
    method: 'cash' | 'store_credit'
    reason?: string
    items: { saleItemId: number; quantity: number }[]
    customerId?: number
  }
  const result = await createRefund({
    staffId: session.staffId,
    saleId: body.saleId,
    method: body.method,
    reason: body.reason,
    items: body.items ?? [],
    customerId: body.customerId,
  })
  return NextResponse.json(result, { status: 201 })
})
