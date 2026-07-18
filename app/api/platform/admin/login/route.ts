import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { getAdminSession, verifyAdminPassword } from '@/lib/platform/admin-auth'

const loginBody = z.object({ password: z.string().min(1) })

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`admin-login:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts — try again in a few minutes')
  }
  const { password } = await parseBody(req, loginBody)
  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }
  const session = await getAdminSession()
  session.isPlatformAdmin = true
  await session.save()
  return NextResponse.json({ ok: true })
})

export const DELETE = guarded(async () => {
  const session = await getAdminSession()
  session.destroy()
  return NextResponse.json({ ok: true })
})
