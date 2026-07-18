// app/api/sales/[id]/receipt/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { buildReceiptData, emailReceipt } from '@/lib/domain/receipts'

// Rebuild a past sale's receipt (reports search → re-print / re-email).
export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const saleId = parseIdParam((await params).id, 'sale id')
  const { receipt, customerEmail } = await buildReceiptData(saleId, db)
  return NextResponse.json({ receipt, customerEmail })
})

const receiptBody = z.object({
  // Explicit address wins; omitted → the sale's customer email.
  email: z.string().email().optional(),
})

export const POST = guarded(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const saleId = parseIdParam((await params).id, 'sale id')
  const body = await parseBody(req, receiptBody)
  const result = await emailReceipt({ saleId, email: body.email }, db)
  // skipped (no provider configured) is an expected state the UI explains;
  // only a genuine provider failure is an error.
  const status = result.ok || result.skipped ? 200 : 502
  return NextResponse.json(result, { status })
})
