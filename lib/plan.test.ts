import { test } from 'node:test'
import assert from 'node:assert'
import { PLANS, PLAN_IDS, isPlan, entitlementsFor } from './plan'

test('three plans with pence prices and seat limits', () => {
  assert.deepEqual(PLAN_IDS, ['starter', 'growth', 'pro'])
  assert.equal(PLANS.starter.pricePence, 3900)
  assert.equal(PLANS.growth.pricePence, 7900)
  assert.equal(PLANS.pro.pricePence, 14900)
  assert.equal(PLANS.starter.entitlements.staffSeats, 2)
  assert.equal(PLANS.growth.entitlements.staffSeats, 5)
  assert.equal(PLANS.pro.entitlements.staffSeats, null)
})

test('isPlan narrows', () => {
  assert.ok(isPlan('starter'))
  assert.ok(!isPlan('enterprise'))
  assert.ok(!isPlan(null))
})

test('entitlementsFor merges registry overrides field-by-field', () => {
  assert.deepEqual(entitlementsFor('starter'), { staffSeats: 2, listingSync: false, apiAccess: false })
  assert.deepEqual(entitlementsFor('starter', '{"staffSeats":10}'),
    { staffSeats: 10, listingSync: false, apiAccess: false })
  // Malformed overrides never break resolution — base plan wins.
  assert.deepEqual(entitlementsFor('growth', 'not json'), entitlementsFor('growth'))
  // Never mutate the shared PLANS object.
  entitlementsFor('pro').apiAccess = false
  assert.equal(PLANS.pro.entitlements.apiAccess, true)
})
