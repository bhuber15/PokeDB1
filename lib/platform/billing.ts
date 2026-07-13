import { eq } from 'drizzle-orm'
import { sendEmail } from '@/lib/email'
import { isPlan } from '@/lib/plan'
import type { PlatformDb } from './db'
import { stripeEvents, tenants, platformAudit } from './schema'
import { clearTenantCache, tenantUrl } from './tenants'
import { planForPriceId } from './stripe'
import type { ProvisionInput } from './provision'
import { trialEndingEmail, paymentFailedEmail, suspendedEmail } from './emails'

// Webhook-driven tenant lifecycle (spec §3.5). Division of labour:
//  - status/plan sync: customer.subscription.updated/.deleted ONLY
//    (except payment_failed's immediate past_due, which Stripe also mirrors
//    via a subscription.updated moments later — same terminal state)
//  - lifecycle emails: trial_will_end, invoice.payment_failed, .deleted
//  - provisioning: checkout.session.completed
// Idempotency: claim the event id in stripe_events first; duplicates no-op;
// a failed handler releases the claim so Stripe's retry re-processes.

export interface StripeEventLike {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export interface BillingDeps {
  pdb: PlatformDb
  provision: (input: ProvisionInput) => Promise<unknown>
  send: typeof sendEmail
  baseHost: string
}

export function mapSubscriptionStatus(s: string): string {
  switch (s) {
    case 'trialing': return 'trialing'
    case 'active': return 'active'
    case 'past_due': return 'past_due'
    case 'paused': return 'paused'        // card-less trial ended without a card
    case 'incomplete': return 'trialing'  // first payment still settling — don't lock the shop
    default: return 'suspended'           // canceled | unpaid | incomplete_expired
  }
}

export async function handleStripeEvent(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const claimed = await deps.pdb.insert(stripeEvents)
    .values({ stripeEventId: event.id, type: event.type })
    .onConflictDoNothing()
    .returning()
  if (claimed.length === 0) return { outcome: 'duplicate' }

  try {
    switch (event.type) {
      case 'checkout.session.completed': return await onCheckoutCompleted(event, deps)
      case 'customer.subscription.updated': return await onSubscriptionChanged(event, deps, false)
      case 'customer.subscription.deleted': return await onSubscriptionChanged(event, deps, true)
      case 'customer.subscription.trial_will_end': return await onTrialWillEnd(event, deps)
      case 'invoice.payment_failed': return await onPaymentFailed(event, deps)
      default: return { outcome: `ignored:${event.type}` }
    }
  } catch (e) {
    await deps.pdb.delete(stripeEvents).where(eq(stripeEvents.stripeEventId, event.id))
    throw e
  }
}

interface CheckoutSessionLike {
  customer?: unknown
  subscription?: unknown
  metadata?: Record<string, string> | null
  customer_details?: { email?: string | null } | null
}

async function onCheckoutCompleted(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const s = event.data.object as CheckoutSessionLike
  const slug = s.metadata?.tenant_slug
  const name = s.metadata?.shop_name
  const plan = s.metadata?.plan
  const email = s.customer_details?.email
  if (!slug || !name || !email || !isPlan(plan)) return { outcome: 'ignored:not-signup' }
  await deps.provision({
    slug,
    name,
    email,
    plan,
    stripeCustomerId: typeof s.customer === 'string' ? s.customer : null,
    stripeSubscriptionId: typeof s.subscription === 'string' ? s.subscription : null,
  })
  return { outcome: 'provisioned' }
}

interface SubscriptionLike {
  id: string
  status: string
  items?: { data?: { price?: { id?: string } }[] }
}

async function onSubscriptionChanged(event: StripeEventLike, deps: BillingDeps, deleted: boolean): Promise<{ outcome: string }> {
  const sub = event.data.object as unknown as SubscriptionLike
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeSubscriptionId, sub.id)).limit(1)
  // Unknown subscription: subscription events can outrun checkout.session.completed
  // during signup — the post-provision subscription.updated will catch us up.
  if (!t) return { outcome: 'ignored:unknown-subscription' }
  const status = deleted ? 'suspended' : mapSubscriptionStatus(sub.status)
  const plan = planForPriceId(sub.items?.data?.[0]?.price?.id)
  await deps.pdb.update(tenants)
    .set({ status, ...(plan ? { plan } : {}), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenants.id, t.id))
  await deps.pdb.insert(platformAudit)
    .values({ actor: 'stripe', tenantId: t.id, action: `status:${status}`, detail: event.type })
  clearTenantCache()
  if (deleted && t.email) {
    await deps.send(suspendedEmail({ to: t.email, shopName: t.name }))
  }
  return { outcome: `status:${status}` }
}

async function onTrialWillEnd(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const sub = event.data.object as unknown as SubscriptionLike
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeSubscriptionId, sub.id)).limit(1)
  if (!t?.email) return { outcome: 'ignored:unknown-subscription' }
  await deps.send(trialEndingEmail({
    to: t.email,
    shopName: t.name,
    shopUrl: tenantUrl(t.slug, deps.baseHost, '/settings'),
  }))
  return { outcome: 'emailed:trial_will_end' }
}

interface InvoiceLike { customer?: unknown }

async function onPaymentFailed(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const inv = event.data.object as InvoiceLike
  const customerId = typeof inv.customer === 'string' ? inv.customer : null
  if (!customerId) return { outcome: 'ignored:no-customer' }
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeCustomerId, customerId)).limit(1)
  if (!t) return { outcome: 'ignored:unknown-customer' }
  await deps.pdb.update(tenants)
    .set({ status: 'past_due', updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenants.id, t.id))
  await deps.pdb.insert(platformAudit)
    .values({ actor: 'stripe', tenantId: t.id, action: 'status:past_due', detail: event.type })
  clearTenantCache()
  if (t.email) {
    await deps.send(paymentFailedEmail({
      to: t.email,
      shopName: t.name,
      shopUrl: tenantUrl(t.slug, deps.baseHost, '/settings'),
    }))
  }
  return { outcome: 'status:past_due' }
}
