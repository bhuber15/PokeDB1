import * as Sentry from '@sentry/nextjs'

// Server-side error tracking. With no SENTRY_DSN set (local dev, CI) the SDK
// stays disabled and everything here is a no-op.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0, // errors only — no performance tracing spend
    })
  }
}

export const onRequestError = Sentry.captureRequestError
