import { test } from 'node:test'
import assert from 'node:assert'
import { sendEmail } from './email'

test('sendEmail is a logged no-op without RESEND_API_KEY', async () => {
  delete process.env.RESEND_API_KEY
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' })
  assert.deepEqual(result, { ok: false, skipped: true })
})

test('sendEmail posts to Resend with bearer auth', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.EMAIL_FROM = 'Shop <hello@example.com>'
  let captured: { url: string; init: RequestInit } | null = null
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init! }
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
  }) as typeof fetch
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' }, fakeFetch)
  assert.deepEqual(result, { ok: true, id: 'email_123' })
  assert.equal(captured!.url, 'https://api.resend.com/emails')
  const headers = captured!.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer re_test_key')
  const body = JSON.parse(String(captured!.init.body))
  assert.equal(body.from, 'Shop <hello@example.com>')
  assert.deepEqual(body.to, ['a@b.com'])
  delete process.env.RESEND_API_KEY
  delete process.env.EMAIL_FROM
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
