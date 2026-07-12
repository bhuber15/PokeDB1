import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCardsInSet } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const setName = req.nextUrl.searchParams.get('setName')
  if (!setName) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getCardsInSet(setName, db) })
})
