import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIG = { CRON_SECRET: process.env.CRON_SECRET, BLOB: process.env.BLOB_READ_WRITE_TOKEN }
afterEach(() => {
  if (ORIG.CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIG.CRON_SECRET
  if (ORIG.BLOB === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
  else process.env.BLOB_READ_WRITE_TOKEN = ORIG.BLOB
})

test('401 without secret; skips green without a blob token', async () => {
  delete process.env.CRON_SECRET
  const unauth = await GET(new NextRequest('http://localhost/api/cron/backup-tenants'))
  assert.equal(unauth.status, 401)

  process.env.CRON_SECRET = 's3cret'
  delete process.env.BLOB_READ_WRITE_TOKEN
  const res = await GET(new NextRequest('http://localhost/api/cron/backup-tenants',
    { headers: { authorization: 'Bearer s3cret' } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { skipped: 'no-blob-token' })
})
