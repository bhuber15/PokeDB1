import { test } from 'node:test'
import assert from 'node:assert'
import Stripe from 'stripe'
import { priceIdForPlan, planForPriceId } from './stripe'

test('plan ↔ price id mapping from env', () => {
  process.env.STRIPE_PRICE_STARTER = 'price_st'
  process.env.STRIPE_PRICE_GROWTH = 'price_gr'
  process.env.STRIPE_PRICE_PRO = 'price_pro'
  assert.equal(priceIdForPlan('growth'), 'price_gr')
  assert.equal(planForPriceId('price_pro'), 'pro')
  assert.equal(planForPriceId('price_unknown'), null)
  assert.equal(planForPriceId(null), null)
})

test('priceIdForPlan throws when env is missing', () => {
  delete process.env.STRIPE_PRICE_STARTER
  assert.throws(() => priceIdForPlan('starter'), /STRIPE_PRICE_STARTER/)
})

// Round-trip Stripe's own signature scheme offline — proves the webhook route's
// constructEvent wiring can be satisfied by the CLI/test fixtures.
test('stripe signature verification round-trips', () => {
  const stripe = new Stripe('sk_test_dummy')
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'ping', data: { object: {} } })
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' })
  const event = stripe.webhooks.constructEvent(payload, header, 'whsec_test')
  assert.equal(event.id, 'evt_1')
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, 'whsec_wrong'))
})
