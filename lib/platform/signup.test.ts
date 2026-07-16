import { test } from 'node:test'
import assert from 'node:assert'
import { createSignupCheckout, validateSlug } from './signup'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { DomainError } from '@/lib/domain/errors'

process.env.STRIPE_PRICE_GROWTH = 'price_gr'

test('validateSlug rejects bad formats and reserved names', () => {
  for (const bad of ['ab', 'UPPER', 'has space', '-lead', 'trail-', 'www', 'admin']) {
    assert.throws(() => validateSlug(bad), DomainError, bad)
  }
  validateSlug('brads-cards') // no throw
})

test('createSignupCheckout rejects a taken slug before touching Stripe', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'brads-cards', name: 'Existing', dbUrl: 'file:x.db' })
  await assert.rejects(
    () => createSignupCheckout(
      { shopName: 'B', slug: 'brads-cards', email: 'a@b.com', plan: 'growth', origin: 'http://localhost:3000' },
      { pdb, createCheckout: async () => { throw new Error('should not be called') } },
    ),
    (e: unknown) => e instanceof DomainError && /taken/.test(e.message),
  )
})

test('createSignupCheckout builds the checkout request', async () => {
  const pdb = await createTestPlatformDb()
  let args: Record<string, unknown> | null = null
  const { url } = await createSignupCheckout(
    { shopName: "Brad's Cards", slug: 'brads-cards', email: 'a@b.com', plan: 'growth', origin: 'https://www.example-brand.co.uk' },
    { pdb, createCheckout: async (a) => { args = a as unknown as Record<string, unknown>; return { url: 'https://checkout.stripe.com/c/x' } } },
  )
  assert.equal(url, 'https://checkout.stripe.com/c/x')
  assert.deepEqual(args, {
    priceId: 'price_gr',
    email: 'a@b.com',
    metadata: { tenant_slug: 'brads-cards', shop_name: "Brad's Cards", plan: 'growth' },
    successUrl: 'https://www.example-brand.co.uk/signup/done',
    cancelUrl: 'https://www.example-brand.co.uk/signup',
  })
})
