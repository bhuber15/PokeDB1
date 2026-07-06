import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getNames } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  return NextResponse.json({ names: await getNames(q) })
})
