import { test } from 'node:test'
import assert from 'node:assert'
import { guarded } from './api'
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
