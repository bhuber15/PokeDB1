// Fixed-window in-memory limiter (spec §3.9). Per-instance state is the right
// trade at launch: instances are reused under Fluid compute, and the goal is
// blunting abuse on public endpoints, not precise global quotas.
//
// Callers key by the first x-forwarded-for hop, which a client can spoof when
// the app runs anywhere without a trusted proxy in front (i.e. off-Vercel) —
// so this limiter only blunts naive floods; the DB-backed lockout
// (lib/domain/auth-lockout.ts) remains the real brute-force guard.
const buckets = new Map<string, { windowStart: number; windowMs: number; count: number }>()

// Bounded so a key-churning flood (e.g. spoofed x-forwarded-for) cannot grow
// the map without limit. At the cap, expired windows are swept; if every
// remaining window is still live, unseen keys are refused — reaching the cap
// means an active flood, so fail closed rather than open.
export const RATE_LIMIT_MAX_KEYS = 10_000

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key)
  if (b && now - b.windowStart < windowMs) {
    b.count += 1
    return b.count <= limit
  }
  if (!b && buckets.size >= RATE_LIMIT_MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (now - v.windowStart >= v.windowMs) buckets.delete(k)
    }
    if (buckets.size >= RATE_LIMIT_MAX_KEYS) return false
  }
  buckets.set(key, { windowStart: now, windowMs, count: 1 })
  return true
}

export function resetRateLimits(): void {
  buckets.clear()
}
