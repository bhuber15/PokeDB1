import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCashUpSummary } from '@/lib/domain/reports'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const day = req.nextUrl.searchParams.get('day') ?? new Date().toISOString().slice(0, 10)
  if (!DATE_RE.test(day)) {
    return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 })
  }
  return NextResponse.json(await getCashUpSummary(day, db))
})
