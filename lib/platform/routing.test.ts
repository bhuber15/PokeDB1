import { test } from 'node:test'
import assert from 'node:assert'
import { decideTenantRouting, decideAdminRouting, isAdminHost } from './routing'

const tenant = (status: string) => ({
  id: 7, dbUrl: 'file:/tmp/t.db', status, plan: 'starter', entitlementOverrides: null,
})

test('no slug → not a tenant host', () => {
  assert.deepEqual(decideTenantRouting({ slug: null, tenant: null }), { kind: 'not-tenant' })
})

test('slug with no registry row → unknown', () => {
  assert.deepEqual(decideTenantRouting({ slug: 'ghost', tenant: null }), { kind: 'unknown' })
})

test('suspended/cancelled/paused tenants are blocked', () => {
  for (const s of ['suspended', 'cancelled', 'paused']) {
    assert.deepEqual(decideTenantRouting({ slug: 'x', tenant: tenant(s) }), { kind: 'blocked', status: s })
  }
})

test('live tenants get trusted headers', () => {
  for (const s of ['trialing', 'active', 'past_due']) {
    const d = decideTenantRouting({ slug: 'x', tenant: tenant(s) })
    assert.equal(d.kind, 'serve')
    if (d.kind !== 'serve') return
    assert.equal(d.headers['x-tenant-id'], '7')
    assert.equal(d.headers['x-tenant-db-url'], 'file:/tmp/t.db')
    assert.equal(d.headers['x-tenant-status'], s)
    assert.equal(d.headers['x-tenant-plan'], 'starter')
    assert.deepEqual(JSON.parse(d.headers['x-tenant-entitlements']),
      { staffSeats: 2, listingSync: false, apiAccess: false })
  }
})

test('serve injects plan and merged entitlements headers', () => {
  const d = decideTenantRouting({
    slug: 'brads',
    tenant: { id: 7, dbUrl: 'file:x.db', status: 'active', plan: 'starter', entitlementOverrides: '{"staffSeats":10}' },
  })
  assert.equal(d.kind, 'serve')
  if (d.kind !== 'serve') return
  assert.equal(d.headers['x-tenant-plan'], 'starter')
  assert.deepEqual(JSON.parse(d.headers['x-tenant-entitlements']),
    { staffSeats: 10, listingSync: false, apiAccess: false })
})

test('an unrecognised plan value falls back to growth entitlements', () => {
  const d = decideTenantRouting({
    slug: 'brads',
    tenant: { id: 7, dbUrl: 'file:x.db', status: 'active', plan: 'legacy-weird', entitlementOverrides: null },
  })
  if (d.kind !== 'serve') assert.fail('expected serve')
  assert.equal(d.headers['x-tenant-plan'], 'growth')
})

test('isAdminHost matches only the admin subdomain of the base host', () => {
  assert.equal(isAdminHost('admin.example-brand.co.uk', 'example-brand.co.uk'), true)
  assert.equal(isAdminHost('ADMIN.Example-Brand.co.uk:3000', 'example-brand.co.uk'), true)
  assert.equal(isAdminHost('admin.evil.com', 'example-brand.co.uk'), false)
  assert.equal(isAdminHost('shop.example-brand.co.uk', 'example-brand.co.uk'), false)
  assert.equal(isAdminHost('example-brand.co.uk', 'example-brand.co.uk'), false)
})

test('admin routing: APIs pass (handlers self-gate); login page always reachable', () => {
  assert.deepEqual(decideAdminRouting('/api/platform/admin/login', false), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/api/health', false), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/admin/login', false), { kind: 'pass' })
})

test('admin routing: pages gate on the session', () => {
  assert.deepEqual(decideAdminRouting('/admin', false), { kind: 'redirect-login' })
  assert.deepEqual(decideAdminRouting('/', false), { kind: 'redirect-login' })
  assert.deepEqual(decideAdminRouting('/admin', true), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/admin/audit', true), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/', true), { kind: 'rewrite', path: '/admin' })
})

test('admin routing: shop paths do not exist on the admin host', () => {
  assert.deepEqual(decideAdminRouting('/pos', true), { kind: 'not-found' })
  assert.deepEqual(decideAdminRouting('/login', false), { kind: 'redirect-login' })
})
