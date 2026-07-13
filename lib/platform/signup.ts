import { eq } from 'drizzle-orm'
import { DomainError } from '@/lib/domain/errors'
import type { Plan } from '@/lib/plan'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants as tenantsTable } from './schema'
import { RESERVED_SLUGS, TENANT_SLUG_RE } from './tenants'
import { getStripe, priceIdForPlan } from './stripe'

export interface SignupInput {
  shopName: string
  slug: string
  email: string
  plan: Plan
  origin: string
}

export interface CheckoutCreator {
  (args: {
    priceId: string
    email: string
    metadata: Record<string, string>
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string | null }>
}

export function validateSlug(slug: string): void {
  if (!TENANT_SLUG_RE.test(slug)) {
    throw new DomainError('INVALID_INPUT', 'Subdomain must be 3–40 characters: lowercase letters, digits and hyphens')
  }
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    throw new DomainError('INVALID_INPUT', 'That subdomain is reserved')
  }
}

// Signup step 1 (spec §3.6): validate, check availability, hand off to Stripe
// Checkout. The tenant is created by the checkout.session.completed webhook —
// nothing is written here, so an abandoned checkout leaves no residue. (Two
// simultaneous signups for one slug can both reach Checkout; the second one's
// webhook finds the slug taken and fails loudly for manual follow-up — an
// acceptable race at launch volume.)
export async function createSignupCheckout(
  input: SignupInput,
  deps: { pdb?: PlatformDb; createCheckout?: CheckoutCreator } = {},
): Promise<{ url: string }> {
  const pdb = deps.pdb ?? getPlatformDb()
  validateSlug(input.slug)
  const [taken] = await pdb.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(eq(tenantsTable.slug, input.slug)).limit(1)
  if (taken) throw new DomainError('INVALID_INPUT', 'That subdomain is already taken')

  const createCheckout = deps.createCheckout ?? stripeCheckout
  const { url } = await createCheckout({
    priceId: priceIdForPlan(input.plan),
    email: input.email,
    metadata: { tenant_slug: input.slug, shop_name: input.shopName, plan: input.plan },
    successUrl: `${input.origin}/signup/done`,
    cancelUrl: `${input.origin}/signup`,
  })
  if (!url) throw new Error('Stripe returned no checkout URL')
  return { url }
}

const stripeCheckout: CheckoutCreator = async (args) => {
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    // 14-day card-less trial (spec §3.5): nothing is due today so Checkout
    // shows no card fields; if no card exists at trial end Stripe pauses the
    // subscription (→ tenant status 'paused'), and adding a card via the
    // customer portal resumes it.
    payment_method_collection: 'if_required',
    subscription_data: {
      trial_period_days: 14,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
      metadata: args.metadata,
    },
    customer_email: args.email,
    metadata: args.metadata,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })
  return { url: session.url }
}
