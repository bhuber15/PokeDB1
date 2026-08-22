import { test } from 'node:test'
import assert from 'node:assert'
import { PLANS, entitlementsFor, gamesAllowed } from './plan'

test('entitlementsFor merges registry overrides field-by-field', () => {
  assert.deepEqual(entitlementsFor('starter'), { staffSeats: 2, listingSync: false, apiAccess: false, multiGame: false })
  assert.deepEqual(entitlementsFor('starter', '{"staffSeats":10}'),
    { staffSeats: 10, listingSync: false, apiAccess: false, multiGame: false })
  // Malformed overrides never break resolution — base plan wins.
  assert.deepEqual(entitlementsFor('growth', 'not json'), entitlementsFor('growth'))
  // Never mutate the shared PLANS object.
  entitlementsFor('pro').apiAccess = false
  assert.equal(PLANS.pro.entitlements.apiAccess, true)
})

test('multiGame entitlement is off on Starter, on for Growth and Pro', () => {
  assert.equal(PLANS.starter.entitlements.multiGame, false)
  assert.equal(PLANS.growth.entitlements.multiGame, true)
  assert.equal(PLANS.pro.entitlements.multiGame, true)
})

test('entitlement_overrides can force multiGame on for a founding Starter shop', () => {
  assert.equal(entitlementsFor('starter').multiGame, false)
  assert.equal(entitlementsFor('starter', JSON.stringify({ multiGame: true })).multiGame, true)
})

test('gamesAllowed: a second game needs multiGame; pokemon-only is always fine', () => {
  assert.equal(gamesAllowed(PLANS.starter.entitlements, ['pokemon', 'mtg']), false)
  assert.equal(gamesAllowed(PLANS.starter.entitlements, ['pokemon']), true)
  assert.equal(gamesAllowed(PLANS.growth.entitlements, ['pokemon', 'mtg', 'yugioh']), true)
})
