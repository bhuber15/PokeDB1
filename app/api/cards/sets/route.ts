import { NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getSets } from '@/lib/domain/catalogue'

export const GET = guarded(async () => {
  requireStaff(await getSession())
  return NextResponse.json({ sets: await getSets() })
})
