import * as Sentry from '@sentry/nextjs'

// Browser-side error tracking. Disabled unless NEXT_PUBLIC_SENTRY_DSN is set
// at build time (local dev and CI leave it unset).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
