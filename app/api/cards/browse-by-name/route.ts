import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getPrintingsByName } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const name = req.nextUrl.searchParams.get('name')
  if (!name) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getPrintingsByName(name, db) })
})
