import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestPlatformDb } from './test-helpers'
import { tenants, tenantSyncState } from './schema'
import { forEachDueTenant } from './fanout'

const HOUR = 3600

type Pdb = Awaited<ReturnType<typeof createTestPlatformDb>>

async function seedTenant(pdb: Pdb, slug: string, status: string, lastPriceSyncAt: number | null) {
  const [t] = await pdb.insert(tenants).values({ slug, name: slug, dbUrl: `file:${slug}.db`, status }).returning()
  if (lastPriceSyncAt !== null) {
    await pdb.insert(tenantSyncState).values({ tenantId: t.id, lastPriceSyncAt })
  }
  return t
}

test('processes due tenants oldest-first, never-synced first of all, and advances the cursor', async () => {
  const pdb = await createTestPlatformDb()
  const nowS = 100 * HOUR
  await seedTenant(pdb, 'fresh', 'active', nowS - 1 * HOUR)      // not due
  await seedTenant(pdb, 'oldest', 'active', nowS - 50 * HOUR)    // due, oldest timestamp
  await seedTenant(pdb, 'stale', 'active', nowS - 21 * HOUR)     // due
  await seedTenant(pdb, 'never', 'active', null)                 // no sync row at all → most urgent

  const ran: string[] = []
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => nowS * 1000 },
    async (t) => { ran.push(t.slug) },
  )
  assert.deepEqual(ran, ['never', 'oldest', 'stale'])
  assert.equal(result.due, 3)
  assert.equal(result.remaining, 0)
  assert.deepEqual(result.processed.map(p => p.ok), [true, true, true])

  // Cursor advanced for all three (including the row-less tenant via upsert).
  const states = await pdb.select().from(tenantSyncState)
  const cursorByTenantId = new Map(states.map(s => [s.tenantId, s.lastPriceSyncAt]))
  const all = await pdb.select().from(tenants)
  for (const t of all.filter(t => t.slug !== 'fresh')) {
    assert.equal(cursorByTenantId.get(t.id), nowS, `${t.slug} cursor`)
  }
  // Not-due tenant untouched.
  const fresh = all.find(t => t.slug === 'fresh')!
  assert.equal(cursorByTenantId.get(fresh.id), nowS - 1 * HOUR)
})

test('skips suspended/cancelled/paused tenants', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'live', 'active', null)
  await seedTenant(pdb, 'dead', 'suspended', null)
  await seedTenant(pdb, 'gone', 'cancelled', null)
  await seedTenant(pdb, 'iced', 'paused', null)
  const ran: string[] = []
  await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 0 },
    async (t) => { ran.push(t.slug) },
  )
  assert.deepEqual(ran, ['live'])
})

test('stops when the budget is spent but always processes at least one', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'a', 'active', null)
  await seedTenant(pdb, 'b', 'active', null)
  await seedTenant(pdb, 'c', 'active', null)
  let clock = 0
  const ran: string[] = []
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 10_000, nowMs: () => clock },
    async (t) => { ran.push(t.slug); clock += 11_000 },   // each job overshoots the budget
  )
  assert.equal(ran.length, 1)
  assert.equal(result.remaining, 2)
})

test('a failing tenant is recorded, does not stop the loop, and its cursor still advances', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'boom', 'active', null)
  await seedTenant(pdb, 'fine', 'active', 100)
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 200 * HOUR * 1000 },
    async (t) => { if (t.slug === 'boom') throw new Error('db unreachable') },
  )
  assert.deepEqual(result.processed, [
    { slug: 'boom', ok: false, error: 'db unreachable' },
    { slug: 'fine', ok: true },
  ])
  const states = await pdb.select().from(tenantSyncState)
  assert.equal(states.length, 2)
  for (const s of states) assert.equal(s.lastPriceSyncAt, 200 * HOUR)
})

test('lastBackupAt uses its own column', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seedTenant(pdb, 'bk', 'active', 500)   // price cursor fresh-ish, backup never
  await forEachDueTenant(
    { pdb, field: 'lastBackupAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 1000 * 1000 },
    async () => {},
  )
  const [s] = await pdb.select().from(tenantSyncState).where(eq(tenantSyncState.tenantId, t.id))
  assert.equal(s.lastBackupAt, 1000)
  assert.equal(s.lastPriceSyncAt, 500)   // untouched
})
