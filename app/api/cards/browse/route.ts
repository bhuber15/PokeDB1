import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCardsInSet } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const setName = req.nextUrl.searchParams.get('setName')
  if (!setName) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getCardsInSet(setName) })
})
