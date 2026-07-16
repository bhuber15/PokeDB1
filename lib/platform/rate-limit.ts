// Fixed-window in-memory limiter (spec §3.9). Per-instance state is the right
// trade at launch: instances are reused under Fluid compute, and the goal is
// blunting abuse on public endpoints, not precise global quotas.
const buckets = new Map<string, { windowStart: number; count: number }>()

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key)
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 })
    return true
  }
  b.count += 1
  return b.count <= limit
}

export function resetRateLimits(): void {
  buckets.clear()
}
