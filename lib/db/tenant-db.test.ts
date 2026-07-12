import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { sql } from 'drizzle-orm'
import { db, getTenantDb, getTenantDbFor, isMultiTenant } from './index'

const originalMode = process.env.TENANCY_MODE
afterEach(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = originalMode
})

test('single mode: getTenantDb returns the working singleton', async () => {
  delete process.env.TENANCY_MODE
  assert.equal(isMultiTenant(), false)
  const d = await getTenantDb()
  await d.run(sql`select 1`) // env :memory: from npm test
})

test('multi mode: touching the singleton throws loudly', async () => {
  process.env.TENANCY_MODE = 'multi'
  assert.equal(isMultiTenant(), true)
  await assert.rejects(async () => db.run(sql`select 1`), /TENANCY_MODE=multi/)
})

test('getTenantDbFor returns isolated, cached clients', async () => {
  // getTenantDbFor must return distinct clients for distinct URLs
  // and the same instance for repeat calls.
  const a = getTenantDbFor('1', 'file:/tmp/tenant-a-test.db')
  const b = getTenantDbFor('2', 'file:/tmp/tenant-b-test.db')
  const a2 = getTenantDbFor('1', 'file:/tmp/tenant-a-test.db')
  assert.notEqual(a, b)
  assert.equal(a, a2)
  // Same tenant id with a rotated URL must produce a fresh client.
  const aRotated = getTenantDbFor('1', 'file:/tmp/tenant-a-rotated-test.db')
  assert.notEqual(aRotated, a)
})
