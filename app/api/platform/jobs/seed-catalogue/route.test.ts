import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { NextRequest } from 'next/server'
import { POST } from './route'

const ORIGINAL = { CRON_SECRET: process.env.CRON_SECRET, TENANCY_MODE: process.env.TENANCY_MODE }
afterEach(() => {
  if (ORIGINAL.CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL.CRON_SECRET
  if (ORIGINAL.TENANCY_MODE === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = ORIGINAL.TENANCY_MODE
})

function req(auth?: string) {
  return new NextRequest('http://localhost/api/platform/jobs/seed-catalogue', {
    method: 'POST',
    body: JSON.stringify({ tenantId: 1 }),
    ...(auth ? { headers: { authorization: auth } } : {}),
  })
}

test('401s without the cron secret (and with no secret configured at all)', async () => {
  delete process.env.CRON_SECRET
  assert.equal((await POST(req())).status, 401)
  assert.equal((await POST(req('Bearer undefined'))).status, 401)
  process.env.CRON_SECRET = 's3cret'
  assert.equal((await POST(req('Bearer wrong'))).status, 401)
})

test('404s outside multi-tenant mode even with the right secret', async () => {
  process.env.CRON_SECRET = 's3cret'
  delete process.env.TENANCY_MODE
  assert.equal((await POST(req('Bearer s3cret'))).status, 404)
})
