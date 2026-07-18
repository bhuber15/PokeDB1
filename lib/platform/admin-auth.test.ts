import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import bcrypt from 'bcryptjs'
import { verifyAdminPassword, requirePlatformAdmin, adminSessionOptions } from './admin-auth'

const ORIG = process.env.PLATFORM_ADMIN_PASSWORD_HASH
afterEach(() => {
  if (ORIG === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  else process.env.PLATFORM_ADMIN_PASSWORD_HASH = ORIG
})

test('verifyAdminPassword fails closed when the env hash is unset', async () => {
  delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  assert.equal(await verifyAdminPassword('anything'), false)
})

test('verifyAdminPassword compares against the env bcrypt hash', async () => {
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('hunter2', 4)
  assert.equal(await verifyAdminPassword('hunter2'), true)
  assert.equal(await verifyAdminPassword('wrong'), false)
})

test('requirePlatformAdmin throws UNAUTHORIZED without the flag', () => {
  assert.throws(() => requirePlatformAdmin({}), /Platform admin/)
  assert.doesNotThrow(() => requirePlatformAdmin({ isPlatformAdmin: true }))
})

test('admin cookie is its own name, not the shop session cookie', () => {
  assert.equal(adminSessionOptions.cookieName, 'platform-admin-session')
})
