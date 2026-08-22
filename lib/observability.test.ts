import { test } from 'node:test'
import assert from 'node:assert'
import { captureException } from './observability'

// Load-bearing despite its size: guarded() awaits captureException on every
// unexpected-error path, and SENTRY_DSN is unset in every current deploy. If
// this ever throws, each would-be 500 becomes an unhandled rejection that
// masks the real error.
test('captureException is a silent no-op without SENTRY_DSN', async () => {
  const orig = process.env.SENTRY_DSN
  delete process.env.SENTRY_DSN
  await assert.doesNotReject(captureException(new Error('boom')))
  if (orig !== undefined) process.env.SENTRY_DSN = orig
})
