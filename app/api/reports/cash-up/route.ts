import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getCashUpSummary } from '@/lib/domain/reports'
import { closeCashUp, getCashUpForDay, listCashUps } from '@/lib/domain/cash-ups'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const day = req.nextUrl.searchParams.get('day') ?? new Date().toISOString().slice(0, 10)
  if (!DATE_RE.test(day)) {
    return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 })
  }
  const [summary, close, recent] = await Promise.all([
    getCashUpSummary(day, db),
    getCashUpForDay(day, db),
    listCashUps(14, db),
  ])
  return NextResponse.json({ summary, close, recent })
})

const closeSchema = z.object({
  day: z.string().regex(DATE_RE, 'must be YYYY-MM-DD'),
  openingFloat: z.number().int().min(0),
  countedCash: z.number().int().min(0),
  notes: z.string().max(500).optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireAdmin(await getSession(await currentTenantId()))
  const body = await parseBody(req, closeSchema)
  const record = await closeCashUp({ ...body, staffId: session.staffId }, db)
  return NextResponse.json({ close: record }, { status: 201 })
})
