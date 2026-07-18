// app/api/sales/[id]/void/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { voidSale } from '@/lib/domain/voids'

const voidBody = z.object({
  reason: z.string().max(500).optional(),
})

export const POST = guarded(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))
  const saleId = parseIdParam((await params).id, 'sale id')
  const body = await parseBody(req, voidBody)
  const result = await voidSale({ staffId: session.staffId, saleId, reason: body.reason }, db)
  return NextResponse.json(result)
})
