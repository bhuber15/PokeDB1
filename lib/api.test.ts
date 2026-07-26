import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { guarded, isAuthorizedCron } from './api'
import { DomainError } from './domain/errors'

test('guarded maps DomainError to its status and body', async () => {
  const handler = guarded(async () => { throw new DomainError('RATE_LIMITED', 'slow down') })
  const res = await handler()
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { error: 'slow down', code: 'RATE_LIMITED' })
})

test('guarded turns unexpected errors into a generic 500 (and does not leak the message)', async () => {
  const handler = guarded(async () => { throw new Error('secret internals') })
  const res = await handler()
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: 'Internal error' })
})

const ORIG_CRON_SECRET = process.env.CRON_SECRET
afterEach(() => {
  if (ORIG_CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIG_CRON_SECRET
})

const cronReq = (auth?: string) =>
  new Request('http://localhost/api/cron/x', auth ? { headers: { authorization: auth } } : undefined)

test('isAuthorizedCron fails closed when CRON_SECRET is unset', () => {
  delete process.env.CRON_SECRET
  assert.equal(isAuthorizedCron(cronReq()), false)
  assert.equal(isAuthorizedCron(cronReq('Bearer undefined')), false)
})

test('isAuthorizedCron rejects missing, wrong, or malformed bearer tokens', () => {
  process.env.CRON_SECRET = 's3cret'
  assert.equal(isAuthorizedCron(cronReq()), false)
  assert.equal(isAuthorizedCron(cronReq('Bearer wrong1')), false) // same length, wrong bytes
  assert.equal(isAuthorizedCron(cronReq('Bearer s3cret-and-more')), false)
  assert.equal(isAuthorizedCron(cronReq('s3cret')), false) // missing Bearer prefix
})

test('isAuthorizedCron accepts the exact bearer secret', () => {
  process.env.CRON_SECRET = 's3cret'
  assert.equal(isAuthorizedCron(cronReq('Bearer s3cret')), true)
})
