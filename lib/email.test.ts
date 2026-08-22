import { test } from 'node:test'
import assert from 'node:assert'
import { sendEmail } from './email'

test('sendEmail is a logged no-op without RESEND_API_KEY', async () => {
  delete process.env.RESEND_API_KEY
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' })
  assert.deepEqual(result, { ok: false, skipped: true })
})

test('sendEmail reports failure without throwing', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  const fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' }, fakeFetch)
  assert.deepEqual(result, { ok: false })
  delete process.env.RESEND_API_KEY
})

test('sendEmail reports network errors instead of rejecting', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  const fakeFetch = (async () => { throw new Error('network down') }) as typeof fetch
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' }, fakeFetch)
  assert.deepEqual(result, { ok: false })
  delete process.env.RESEND_API_KEY
})
