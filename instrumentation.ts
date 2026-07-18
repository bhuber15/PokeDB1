import * as Sentry from '@sentry/nextjs'

// Server-side error tracking. With no SENTRY_DSN set (local dev, CI) the SDK
// stays disabled and everything here is a no-op.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      // errors only by default — no performance tracing spend
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
    })
  }
}

export const onRequestError = Sentry.captureRequestError
