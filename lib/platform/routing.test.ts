import { test } from 'node:test'
import assert from 'node:assert'
import { decideTenantRouting } from './routing'

const tenant = (status: string) => ({ id: 7, dbUrl: 'file:/tmp/t.db', status })

test('no slug → not a tenant host', () => {
  assert.deepEqual(decideTenantRouting({ slug: null, tenant: null }), { kind: 'not-tenant' })
})

test('slug with no registry row → unknown', () => {
  assert.deepEqual(decideTenantRouting({ slug: 'ghost', tenant: null }), { kind: 'unknown' })
})

test('suspended/cancelled/paused tenants are blocked', () => {
  for (const s of ['suspended', 'cancelled', 'paused']) {
    assert.deepEqual(decideTenantRouting({ slug: 'x', tenant: tenant(s) }), { kind: 'blocked' })
  }
})

test('live tenants get trusted headers', () => {
  for (const s of ['trialing', 'active', 'past_due']) {
    const d = decideTenantRouting({ slug: 'x', tenant: tenant(s) })
    assert.deepEqual(d, {
      kind: 'serve',
      headers: { 'x-tenant-id': '7', 'x-tenant-db-url': 'file:/tmp/t.db', 'x-tenant-status': s },
    })
  }
})
