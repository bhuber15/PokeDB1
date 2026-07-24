import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCardsInSet } from '@/lib/domain/catalogue'
import { isGame } from '@/lib/games'

export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const setName = req.nextUrl.searchParams.get('setName')
  if (!setName) return NextResponse.json({ cards: [] })
  const g = req.nextUrl.searchParams.get('game')
  const game = g && isGame(g) ? g : undefined
  return NextResponse.json({ cards: await getCardsInSet(setName, db, game) })
})
