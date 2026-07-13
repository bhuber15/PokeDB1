import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { createSignupCheckout } from '@/lib/platform/signup'

const signupBody = z.object({
  shopName: z.string().trim().min(2).max(60),
  slug: z.string().trim().toLowerCase().max(40),
  email: z.email().max(200),
  plan: z.enum(['starter', 'growth', 'pro']),
})

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`signup:${ip}`, 5, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many signup attempts — please try again in a few minutes')
  }
  const input = await parseBody(req, signupBody)
  const { url } = await createSignupCheckout({ ...input, origin: req.nextUrl.origin })
  return NextResponse.json({ url })
})
