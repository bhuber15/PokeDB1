import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIGINAL = { CRON_SECRET: process.env.CRON_SECRET, TENANCY_MODE: process.env.TENANCY_MODE }
afterEach(() => {
  if (ORIGINAL.CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL.CRON_SECRET
  if (ORIGINAL.TENANCY_MODE === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = ORIGINAL.TENANCY_MODE
})

function req(auth?: string) {
  return new NextRequest('http://localhost/api/cron/sync-tenants',
    auth ? { headers: { authorization: auth } } : undefined)
}

test('401s without the cron secret (and with no secret configured at all)', async () => {
  delete process.env.CRON_SECRET
  assert.equal((await GET(req())).status, 401)
  assert.equal((await GET(req('Bearer undefined'))).status, 401)
  process.env.CRON_SECRET = 's3cret'
  assert.equal((await GET(req('Bearer wrong'))).status, 401)
})

test('no-ops green in single-tenant mode', async () => {
  process.env.CRON_SECRET = 's3cret'
  delete process.env.TENANCY_MODE
  const res = await GET(req('Bearer s3cret'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { skipped: 'single-tenant' })
})
