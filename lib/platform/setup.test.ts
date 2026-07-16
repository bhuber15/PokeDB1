import { test } from 'node:test'
import assert from 'node:assert'
import { and, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { completeSetup } from './setup'
import { createTestPlatformDb } from './test-helpers'
import { tenants, platformAudit } from './schema'
import { createTestDb } from '@/lib/db/test-helpers'
import type { Db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { getOwnerPasswordHash } from '@/lib/domain/staff'
import { DomainError } from '@/lib/domain/errors'

async function fixture() {
  const pdb = await createTestPlatformDb()
  const tenantDb = await createTestDb()
  const [t] = await pdb.insert(tenants).values({
    slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:ignored.db',
    setupToken: 'a'.repeat(48),
  }).returning()
  return { pdb, tenantDb, tenant: t }
}

test('completeSetup sets the owner password, creates the admin, and burns the token', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  const r = await completeSetup(
    { tenantId: tenant.id, token: 'a'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' },
    tenantDb, pdb,
  )
  const hash = await getOwnerPasswordHash(tenantDb)
  assert.ok(hash && await bcrypt.compare('hunter2hunter2', hash))
  const [admin] = await tenantDb.select().from(staff).where(eq(staff.id, r.staffId))
  assert.equal(admin.role, 'admin')
  assert.equal(admin.name, 'Brad')
  const [after] = await pdb.select().from(tenants).where(eq(tenants.id, tenant.id))
  assert.equal(after.setupToken, null)
  assert.ok(after.setupCompletedAt)
})

test('a wrong or reused token is rejected', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  const input = { tenantId: tenant.id, token: 'b'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' }
  await assert.rejects(() => completeSetup(input, tenantDb, pdb), DomainError)
  // Right token succeeds once…
  await completeSetup({ ...input, token: 'a'.repeat(48) }, tenantDb, pdb)
  // …and is dead afterwards.
  await assert.rejects(() => completeSetup({ ...input, token: 'a'.repeat(48) }, tenantDb, pdb), DomainError)
})

test('a tenant-DB failure after the claim restores the token for a retry', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  // Reads pass through to the real test Db; writes blow up — the failure
  // lands after the registry claim, exercising the compensating restore.
  // (A shim, not a full Db, hence the cast — it's a test.)
  const broken = new Proxy(tenantDb as object, {
    get(target, prop) {
      if (prop === 'insert' || prop === 'update') return () => { throw new Error('tenant db down') }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Db
  const input = { tenantId: tenant.id, token: 'a'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' }
  await assert.rejects(() => completeSetup(input, broken, pdb), /tenant db down/)
  const [row] = await pdb.select().from(tenants).where(eq(tenants.id, tenant.id))
  assert.equal(row.setupToken, 'a'.repeat(48))
  assert.equal(row.setupCompletedAt, null)
  // The restored link still works against a healthy tenant DB.
  const r = await completeSetup(input, tenantDb, pdb)
  assert.ok(r.staffId)
})

test('a double attempt leaves exactly one setup_completed audit row', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  const input = { tenantId: tenant.id, token: 'a'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' }
  await completeSetup(input, tenantDb, pdb)
  await assert.rejects(() => completeSetup(input, tenantDb, pdb), DomainError)
  const audits = await pdb.select().from(platformAudit)
    .where(and(eq(platformAudit.tenantId, tenant.id), eq(platformAudit.action, 'setup_completed')))
  assert.equal(audits.length, 1)
})
