import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { completeSetup } from './setup'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { createTestDb } from '@/lib/db/test-helpers'
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
