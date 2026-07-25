import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { toHttpError } from '@/lib/domain/errors'
import { captureException } from '@/lib/observability'

// Wraps a route handler: DomainErrors become their mapped JSON response,
// anything else is reported (Sentry, when configured) and becomes a
// generic 500.
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      const mapped = toHttpError(e)
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
      await captureException(e)
      console.error('Unhandled route error:', e)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
  }
}

// Constant-time check of the cron Authorization header. Fails closed: with
// no CRON_SECRET configured nothing is authorized, so `Bearer undefined` can
// never match. The length pre-check is required by timingSafeEqual and only
// leaks the header length, never its content.
export function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')
  if (!header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
