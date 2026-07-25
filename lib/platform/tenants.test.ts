import { test } from 'node:test'
import assert from 'node:assert'
import { parseTenantSlug, getTenantBySlug, getTenantById, clearTenantCache, tenantUrl } from './tenants'
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

test('tenant cache holds its cap by evicting the oldest entry', async () => {
  clearTenantCache()
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'shop-a', name: 'Shop A', dbUrl: 'file:/tmp/a.db' })
  const opts = { db: pdb, now: 1000, maxEntries: 3 }

  assert.equal((await getTenantBySlug('shop-a', opts))!.name, 'Shop A') // oldest entry
  await getTenantBySlug('ghost-1', opts) // negative entries count too
  await getTenantBySlug('ghost-2', opts) // cache now at the cap
  // Rename behind the cache: hits keep serving 'Shop A'; only a re-fetch sees this.
  await pdb.update(tenants).set({ name: 'Renamed' }).where(eq(tenants.slug, 'shop-a'))

  // A hit on a cached entry evicts nothing…
  assert.equal((await getTenantBySlug('shop-a', opts))!.name, 'Shop A')
  // …but caching a fourth slug pushes out the oldest (shop-a)…
  await getTenantBySlug('ghost-3', opts)
  // …so the next shop-a lookup goes back to the DB despite the fresh TTL.
  assert.equal((await getTenantBySlug('shop-a', opts))!.name, 'Renamed')
})

test('getTenantById fetches without caching', async () => {
  const pdb = await createTestPlatformDb()
  const [t] = await pdb.insert(tenants).values({ slug: 'by-id', name: 'By Id', dbUrl: 'file:x.db' }).returning()
  const found = await getTenantById(t.id, { db: pdb })
  assert.equal(found?.slug, 'by-id')
  assert.equal(await getTenantById(999999, { db: pdb }), null)
})

test('tenantUrl builds shop links for prod and local hosts', () => {
  assert.equal(tenantUrl('brads', 'example-brand.co.uk', '/setup?token=t'),
    'https://brads.example-brand.co.uk/setup?token=t')
  assert.equal(tenantUrl('brads', 'localhost', '/settings'), 'http://brads.localhost:3000/settings')
})
