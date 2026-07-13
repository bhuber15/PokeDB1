import { NextRequest, NextResponse, after } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import { getPlatformDb } from '@/lib/platform/db'
import { getStripe } from '@/lib/platform/stripe'
import { handleStripeEvent, type StripeEventLike } from '@/lib/platform/billing'
import { provisionTenant, type ProvisionInput } from '@/lib/platform/provision'

// Stripe webhook (spec §3.5): signature is the authentication; body must stay
// raw for constructEvent, so no parseBody here. Idempotency + retry semantics
// live in handleStripeEvent.

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = req.headers.get('stripe-signature')
  if (!secret || !sig) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const raw = await req.text()
  let event: StripeEventLike
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret) as unknown as StripeEventLike
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const origin = req.nextUrl.origin
  const result = await handleStripeEvent(event, {
    pdb: getPlatformDb(),
    send: sendEmail,
    baseHost: process.env.PLATFORM_BASE_HOST ?? '',
    provision: async (input: ProvisionInput) => {
      const r = await provisionTenant(input)
      if (!r.alreadyProvisioned) scheduleCatalogueSeed(origin, r.tenantId)
      return r
    },
  })
  return NextResponse.json(result)
})

// Kick the ~20K-card catalogue import in its own invocation once we've
// answered Stripe (spec §3.6: background, not inline). Best-effort — the
// 5s abort just detaches us; the job keeps running server-side, and the
// nightly sync-prices cron fully seeds any tenant this misses.
function scheduleCatalogueSeed(origin: string, tenantId: number) {
  after(async () => {
    try {
      await fetch(new URL('/api/platform/jobs/seed-catalogue', origin), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch { /* fire-and-forget */ }
  })
}
