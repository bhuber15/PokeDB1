import { test } from 'node:test'
import assert from 'node:assert'
import { parseTenantSlug, getTenantBySlug, clearTenantCache, tenantUrl } from './tenants'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { eq } from 'drizzle-orm'

const BASE = 'example-brand.co.uk'

test('parseTenantSlug extracts the shop subdomain', () => {
  assert.equal(parseTenantSlug('brads-cards.example-brand.co.uk', BASE), 'brads-cards')
  assert.equal(parseTenantSlug('BRADS-CARDS.Example-Brand.CO.UK', BASE), 'brads-cards')
  assert.equal(parseTenantSlug('brads-cards.example-brand.co.uk:3000', BASE), 'brads-cards')
  assert.equal(parseTenantSlug('  brads-cards.example-brand.co.uk  ', BASE), 'brads-cards')
})

test('parseTenantSlug returns null for apex, reserved, nested, and foreign hosts', () => {
  assert.equal(parseTenantSlug('example-brand.co.uk', BASE), null)          // apex
  assert.equal(parseTenantSlug('www.example-brand.co.uk', BASE), null)      // reserved
  assert.equal(parseTenantSlug('admin.example-brand.co.uk', BASE), null)    // reserved
  assert.equal(parseTenantSlug('a.b.example-brand.co.uk', BASE), null)      // nested
  assert.equal(parseTenantSlug('evil.com', BASE), null)                     // foreign
  assert.equal(parseTenantSlug('example-brand.co.uk.evil.com', BASE), null) // suffix trick
})

test('getTenantBySlug caches for the TTL', async () => {
  clearTenantCache()
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'shop-a', name: 'Shop A', dbUrl: 'file:/tmp/a.db' })

  const first = await getTenantBySlug('shop-a', { db: pdb, now: 1000 })
  assert.equal(first!.name, 'Shop A')

  // Change the row behind the cache's back; cached value should be served…
  await pdb.update(tenants).set({ name: 'Renamed' }).where(eq(tenants.slug, 'shop-a'))
  const cached = await getTenantBySlug('shop-a', { db: pdb, now: 1000 + 59_000 })
  assert.equal(cached!.name, 'Shop A')

  // …until the TTL lapses.
  const fresh = await getTenantBySlug('shop-a', { db: pdb, now: 1000 + 61_000 })
  assert.equal(fresh!.name, 'Renamed')
})

test('getTenantBySlug returns null for unknown slugs (and caches the miss)', async () => {
  clearTenantCache()
  const pdb = await createTestPlatformDb()
  assert.equal(await getTenantBySlug('nope', { db: pdb, now: 0 }), null)
})

test('tenantUrl builds shop links for prod and local hosts', () => {
  assert.equal(tenantUrl('brads', 'example-brand.co.uk', '/setup?token=t'),
    'https://brads.example-brand.co.uk/setup?token=t')
  assert.equal(tenantUrl('brads', 'localhost', '/settings'), 'http://brads.localhost:3000/settings')
})
