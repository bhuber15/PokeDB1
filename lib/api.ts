import { NextResponse } from 'next/server'
import { toHttpError } from '@/lib/domain/errors'

// Wraps a route handler: DomainErrors become their mapped JSON response,
// anything else is logged and becomes a generic 500.
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      const mapped = toHttpError(e)
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
      console.error('Unhandled route error:', e)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
  }
}
