import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestPlatformDb } from './test-helpers'
import { tenants, stripeEvents } from './schema'

test('registry stores and retrieves a tenant by slug', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:/tmp/x.db' })
  const [row] = await pdb.select().from(tenants).where(eq(tenants.slug, 'brads-cards'))
  assert.equal(row.name, "Brad's Cards")
  assert.equal(row.status, 'trialing') // default status
  assert.equal(row.plan, 'growth')     // default plan (research: the sweet-spot tier)
  assert.equal(row.region, 'fra')      // default region (EU for GDPR)
})

test('duplicate slugs are rejected', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'dupe', name: 'A', dbUrl: 'file:/tmp/a.db' })
  await assert.rejects(
    pdb.insert(tenants).values({ slug: 'dupe', name: 'B', dbUrl: 'file:/tmp/b.db' }),
  )
})

test('stripe event ids are unique (webhook idempotency)', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(stripeEvents).values({ stripeEventId: 'evt_1', type: 'checkout.session.completed' })
  await assert.rejects(
    pdb.insert(stripeEvents).values({ stripeEventId: 'evt_1', type: 'checkout.session.completed' }),
  )
})
