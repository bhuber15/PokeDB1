import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { handleStripeEvent, mapSubscriptionStatus, type BillingDeps, type StripeEventLike } from './billing'
import { createTestPlatformDb } from './test-helpers'
import { tenants, stripeEvents } from './schema'
import type { ProvisionInput } from './provision'
import type { EmailMessage } from '@/lib/email'

process.env.STRIPE_PRICE_STARTER = 'price_st'
process.env.STRIPE_PRICE_GROWTH = 'price_gr'
process.env.STRIPE_PRICE_PRO = 'price_pro'

async function makeDeps() {
  const pdb = await createTestPlatformDb()
  const provisioned: ProvisionInput[] = []
  const sent: EmailMessage[] = []
  const deps: BillingDeps = {
    pdb,
    provision: async (input) => { provisioned.push(input); return { tenantId: 1 } },
    send: async (msg) => { sent.push(msg); return { ok: true } },
    baseHost: 'example-brand.co.uk',
  }
  return { pdb, deps, provisioned, sent }
}

function checkoutCompleted(overrides: Partial<Record<string, unknown>> = {}): StripeEventLike {
  return {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_1',
        subscription: 'sub_1',
        customer_details: { email: 'brad@example.com' },
        metadata: { tenant_slug: 'brads-cards', shop_name: "Brad's Cards", plan: 'growth' },
        ...overrides,
      },
    },
  }
}

async function seedTenant(pdb: BillingDeps['pdb']) {
  const [t] = await pdb.insert(tenants).values({
    slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:x.db', email: 'brad@example.com',
    status: 'trialing', plan: 'growth', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
  }).returning()
  return t
}

test('checkout.session.completed provisions from metadata', async () => {
  const { deps, provisioned } = await makeDeps()
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'provisioned')
  assert.deepEqual(provisioned, [{
    slug: 'brads-cards', name: "Brad's Cards", email: 'brad@example.com', plan: 'growth',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
  }])
})

test('duplicate event ids are claimed once', async () => {
  const { deps, provisioned } = await makeDeps()
  await handleStripeEvent(checkoutCompleted(), deps)
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'duplicate')
  assert.equal(provisioned.length, 1)
})

test('a failed handler releases the claim so retries re-process', async () => {
  const { pdb, deps } = await makeDeps()
  deps.provision = async () => { throw new Error('turso down') }
  await assert.rejects(() => handleStripeEvent(checkoutCompleted(), deps), /turso down/)
  const claims = await pdb.select().from(stripeEvents)
  assert.equal(claims.length, 0)
  deps.provision = async () => ({ tenantId: 1 })
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'provisioned')
})

test('a claim-release failure preserves the original handler error (claim survives)', async () => {
  const { pdb, deps } = await makeDeps()
  deps.provision = async () => { throw new Error('turso down') }
  deps.pdb = {
    insert: pdb.insert.bind(pdb),
    select: pdb.select.bind(pdb),
    update: pdb.update.bind(pdb),
    delete: () => { throw new Error('registry down') },
  } as unknown as BillingDeps['pdb']
  await assert.rejects(() => handleStripeEvent(checkoutCompleted(), deps), /turso down/)
  // Documented residual: the release failed, so the claim survived — Stripe's
  // retries see 'duplicate' until the claim row is deleted and the event is
  // redelivered from the dashboard.
  deps.pdb = pdb
  deps.provision = async () => ({ tenantId: 1 })
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'duplicate')
})

test('sessions without our metadata are ignored', async () => {
  const { deps, provisioned } = await makeDeps()
  const r = await handleStripeEvent(checkoutCompleted({ metadata: {} }), deps)
  assert.equal(r.outcome, 'ignored:not-signup')
  assert.equal(provisioned.length, 0)
})

test('subscription.updated syncs status and plan to the registry', async () => {
  const { pdb, deps } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_sub_1', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'price_pro' } }] } } },
  }, deps)
  assert.equal(r.outcome, 'status:active')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'active')
  assert.equal(t.plan, 'pro')
})

test('subscription.updated for an unknown subscription is ignored (event ordering)', async () => {
  const { deps } = await makeDeps()
  const r = await handleStripeEvent({
    id: 'evt_sub_2', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_nope', status: 'active' } },
  }, deps)
  assert.equal(r.outcome, 'ignored:unknown-subscription')
})

test('subscription.deleted suspends and emails the owner', async () => {
  const { pdb, deps, sent } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_del_1', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', status: 'canceled' } },
  }, deps)
  assert.equal(r.outcome, 'status:suspended')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'suspended')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].subject.includes('suspended'))
})

test('trial_will_end sends the trial-ending email', async () => {
  const { pdb, deps, sent } = await makeDeps()
  await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_trial_1', type: 'customer.subscription.trial_will_end',
    data: { object: { id: 'sub_1', status: 'trialing' } },
  }, deps)
  assert.equal(r.outcome, 'emailed:trial_will_end')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.includes('https://brads-cards.example-brand.co.uk/settings'))
})

test('invoice.payment_failed marks past_due and sends dunning', async () => {
  const { pdb, deps, sent } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_inv_1', type: 'invoice.payment_failed',
    data: { object: { customer: 'cus_1' } },
  }, deps)
  assert.equal(r.outcome, 'status:past_due')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'past_due')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].subject.includes('Payment failed'))
})

test('mapSubscriptionStatus covers the lifecycle', () => {
  assert.equal(mapSubscriptionStatus('trialing'), 'trialing')
  assert.equal(mapSubscriptionStatus('active'), 'active')
  assert.equal(mapSubscriptionStatus('past_due'), 'past_due')
  assert.equal(mapSubscriptionStatus('paused'), 'paused')       // card-less trial expired
  assert.equal(mapSubscriptionStatus('incomplete'), 'trialing')
  assert.equal(mapSubscriptionStatus('canceled'), 'suspended')
  assert.equal(mapSubscriptionStatus('unpaid'), 'suspended')
  assert.equal(mapSubscriptionStatus('incomplete_expired'), 'suspended')
})
