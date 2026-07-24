import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getPrintingsByName } from '@/lib/domain/catalogue'
import { isGame } from '@/lib/games'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const name = req.nextUrl.searchParams.get('name')
  if (!name) return NextResponse.json({ cards: [] })
  const g = req.nextUrl.searchParams.get('game')
  const game = g && isGame(g) ? g : undefined
  return NextResponse.json({ cards: await getPrintingsByName(name, db, game) })
})
