import Stripe from 'stripe'
import type { Plan } from '@/lib/plan'

// Lazy singleton: importing this module must never require Stripe env
// (single-tenant deployments have none).
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    _stripe = new Stripe(key)
  }
  return _stripe
}

const PRICE_ENV: Record<Plan, string> = {
  starter: 'STRIPE_PRICE_STARTER',
  growth: 'STRIPE_PRICE_GROWTH',
  pro: 'STRIPE_PRICE_PRO',
}

export function priceIdForPlan(plan: Plan): string {
  const id = process.env[PRICE_ENV[plan]]
  if (!id) throw new Error(`${PRICE_ENV[plan]} is not set`)
  return id
}

export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null
  for (const plan of Object.keys(PRICE_ENV) as Plan[]) {
    if (process.env[PRICE_ENV[plan]] === priceId) return plan
  }
  return null
}
