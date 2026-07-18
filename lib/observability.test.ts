import { test } from 'node:test'
import assert from 'node:assert'
import { captureException } from './observability'

test('captureException is a silent no-op without SENTRY_DSN', async () => {
  const orig = process.env.SENTRY_DSN
  delete process.env.SENTRY_DSN
  await assert.doesNotReject(captureException(new Error('boom')))
  if (orig !== undefined) process.env.SENTRY_DSN = orig
})
