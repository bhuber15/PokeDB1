import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { tenantOverview, clearOverviewCache } from './overview'

beforeEach(() => clearOverviewCache())

async function seed(pdb: Awaited<ReturnType<typeof createTestPlatformDb>>) {
  await pdb.insert(tenants).values([
    { slug: 'alpha', name: 'Alpha', dbUrl: 'file:alpha.db', status: 'active' },
    { slug: 'beta', name: 'Beta', dbUrl: 'file:beta.db', status: 'past_due' },
  ])
}

test('collects per-tenant activity via the probe; failures mark unreachable', async () => {
  const pdb = await createTestPlatformDb()
  await seed(pdb)
  const rows = await tenantOverview({
    pdb,
    nowMs: 1,
    probe: async (t) => {
      if (t.slug === 'beta') throw new Error('connect ECONNREFUSED')
      return '2026-07-17 09:30:00'
    },
  })
  assert.equal(rows.length, 2)
  const alpha = rows.find(r => r.tenant.slug === 'alpha')!
  const beta = rows.find(r => r.tenant.slug === 'beta')!
  assert.deepEqual([alpha.lastActivityAt, alpha.reachable], ['2026-07-17 09:30:00', true])
  assert.deepEqual([beta.lastActivityAt, beta.reachable], [null, false])
})

test('caches for five minutes', async () => {
  const pdb = await createTestPlatformDb()
  await seed(pdb)
  let calls = 0
  const probe = async () => { calls++; return null }
  await tenantOverview({ pdb, nowMs: 0, probe })
  await tenantOverview({ pdb, nowMs: 4 * 60_000, probe })       // cache hit
  assert.equal(calls, 2)                                        // 2 tenants, probed once
  await tenantOverview({ pdb, nowMs: 6 * 60_000, probe })       // expired
  assert.equal(calls, 4)
})
