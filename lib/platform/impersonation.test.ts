import { test } from 'node:test'
import assert from 'node:assert'
import { createTestPlatformDb } from './test-helpers'
import { tenants, platformAudit } from './schema'
import { createImpersonationGrant, consumeImpersonationGrant, GRANT_TTL_S } from './impersonation'

const BASE = 'example-brand.co.uk'

async function seed(pdb: Awaited<ReturnType<typeof createTestPlatformDb>>) {
  const [t] = await pdb.insert(tenants)
    .values({ slug: 'brads-cards', name: "Brad's", dbUrl: 'file:x.db', status: 'active' }).returning()
  return t
}

test('grant → consume round-trip mints once and audits both ends', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seed(pdb)
  const grant = await createImpersonationGrant(t.id, { pdb, baseHost: BASE, nowS: 1000 })
  assert.ok(grant!.url.startsWith(`https://brads-cards.${BASE}/api/auth/impersonate?token=`))
  const token = new URL(grant!.url).searchParams.get('token')!
  assert.equal(token.length, 64)

  const consumed = await consumeImpersonationGrant(token, { pdb, nowS: 1030 })
  assert.equal(consumed?.id, t.id)

  // Single-use: the second consume is a dead token.
  assert.equal(await consumeImpersonationGrant(token, { pdb, nowS: 1031 }), null)

  const audit = await pdb.select().from(platformAudit)
  assert.deepEqual(audit.map(a => a.action), ['impersonate_grant', 'impersonate_login'])
  assert.deepEqual(audit.map(a => a.tenantId), [t.id, t.id])
})

test('expired grants and garbage tokens are rejected', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seed(pdb)
  const grant = await createImpersonationGrant(t.id, { pdb, baseHost: BASE, nowS: 1000 })
  const token = new URL(grant!.url).searchParams.get('token')!
  assert.equal(await consumeImpersonationGrant(token, { pdb, nowS: 1000 + GRANT_TTL_S + 1 }), null)
  assert.equal(await consumeImpersonationGrant('feedfacecafebeef', { pdb, nowS: 1001 }), null)
})

test('granting for an unknown tenant returns null and writes no audit row', async () => {
  const pdb = await createTestPlatformDb()
  assert.equal(await createImpersonationGrant(999, { pdb, baseHost: BASE, nowS: 0 }), null)
  assert.equal((await pdb.select().from(platformAudit)).length, 0)
})
