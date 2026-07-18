import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import bcrypt from 'bcryptjs'
import { NextRequest } from 'next/server'
import { resetRateLimits } from '@/lib/platform/rate-limit'
import { POST } from './route'

const ORIG = { MODE: process.env.TENANCY_MODE, HASH: process.env.PLATFORM_ADMIN_PASSWORD_HASH }
afterEach(() => {
  if (ORIG.MODE === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = ORIG.MODE
  if (ORIG.HASH === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  else process.env.PLATFORM_ADMIN_PASSWORD_HASH = ORIG.HASH
  resetRateLimits()
})

function loginReq(body: unknown, ip = '10.0.0.1') {
  return new NextRequest('http://admin.example-brand.co.uk/api/platform/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

test('404 in single-tenant mode', async () => {
  delete process.env.TENANCY_MODE
  assert.equal((await POST(loginReq({ password: 'x' }))).status, 404)
})

test('401 on a wrong password', async () => {
  process.env.TENANCY_MODE = 'multi'
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct', 4)
  const res = await POST(loginReq({ password: 'wrong' }))
  assert.equal(res.status, 401)
})

test('429 after 10 attempts from one IP; other IPs unaffected', async () => {
  process.env.TENANCY_MODE = 'multi'
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct', 4)
  for (let i = 0; i < 10; i++) await POST(loginReq({ password: 'wrong' }, '10.9.9.9'))
  const res = await POST(loginReq({ password: 'wrong' }, '10.9.9.9'))
  assert.equal(res.status, 429)
  const other = await POST(loginReq({ password: 'wrong' }, '10.8.8.8'))
  assert.equal(other.status, 401)
})
