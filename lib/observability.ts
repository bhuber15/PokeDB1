// Error-reporting seam (spec §3.9). No-op unless SENTRY_DSN is set, so
// tests, local dev and single-tenant deploys never load the SDK. Server
// init lives in instrumentation.ts; this seam exists because guarded()
// catches route errors before Next's onRequestError can see them.
export async function captureException(e: unknown): Promise<void> {
  if (!process.env.SENTRY_DSN) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.captureException(e)
  } catch {
    // reporting must never break the request
  }
}
