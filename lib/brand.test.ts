import { test } from 'node:test'
import assert from 'node:assert'
import { BRAND } from './brand'

test('brand has a name and support email', () => {
  assert.ok(BRAND.name.length > 0)
  assert.ok(BRAND.supportEmail.includes('@'))
})

test('brand name is a plain string (no template artifacts)', () => {
  assert.ok(!BRAND.name.includes('undefined'))
})
