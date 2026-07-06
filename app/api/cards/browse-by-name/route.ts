import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getPrintingsByName } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const name = req.nextUrl.searchParams.get('name')
  if (!name) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getPrintingsByName(name) })
})
