import * as Sentry from '@sentry/nextjs'

// Browser-side error tracking. Disabled unless NEXT_PUBLIC_SENTRY_DSN is set
// at build time (local dev and CI leave it unset).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
})

// Product analytics (spec §3.9), env-gated behind a dynamic import so the
// posthog-js bundle never ships when the key is unset (NEXT_PUBLIC_* vars are
// inlined at build time, making this branch dead code without it).
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      // EU cloud by default — consistent with the platform's Frankfurt data residency.
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com',
      capture_pageview: 'history_change',   // app-router SPA navigations
    })
  }).catch(() => {})
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
