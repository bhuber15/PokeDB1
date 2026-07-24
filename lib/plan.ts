// Plan → entitlement mapping (spec §3.5). Dependency-free and client-importable
// (the lib/adjustment-reasons.ts pattern): the UI shows plan facts, the server
// enforces them. Prices are integer pence, display-only — Stripe owns billing
// amounts via dashboard-configured prices.
import { type Game } from '@/lib/games'

export type Plan = 'starter' | 'growth' | 'pro'

export interface Entitlements {
  staffSeats: number | null // null = unlimited
  listingSync: boolean      // Pro, future (spec §3.5)
  apiAccess: boolean        // Pro, future
  multiGame: boolean        // Growth+ (spec 2026-07-23) — a second game
}

export const PLANS: Record<Plan, { label: string; pricePence: number; entitlements: Entitlements }> = {
  starter: { label: 'Starter', pricePence: 3900, entitlements: { staffSeats: 2, listingSync: false, apiAccess: false, multiGame: false } },
  growth: { label: 'Growth', pricePence: 7900, entitlements: { staffSeats: 5, listingSync: false, apiAccess: false, multiGame: true } },
  pro: { label: 'Pro', pricePence: 14900, entitlements: { staffSeats: null, listingSync: true, apiAccess: true, multiGame: true } },
}

export const PLAN_IDS = Object.keys(PLANS) as Plan[]

export function isPlan(x: unknown): x is Plan {
  return typeof x === 'string' && x in PLANS
}

// Registry entitlement_overrides JSON wins field-by-field (founding-shop deals,
// seat bumps). Malformed JSON is ignored rather than breaking tenant resolution.
export function entitlementsFor(plan: Plan, overridesJson?: string | null): Entitlements {
  const base = { ...PLANS[plan].entitlements }
  if (!overridesJson) return base
  try {
    return { ...base, ...(JSON.parse(overridesJson) as Partial<Entitlements>) }
  } catch {
    return base
  }
}

// A tenant may enable more than one game only with the multiGame entitlement.
// Pure/declarative so the client (SettingsForm) can grey out the toggle and
// the server (settings route) can reject the write with the same rule.
export function gamesAllowed(ent: Entitlements, enabledGames: Game[]): boolean {
  return enabledGames.length <= 1 || ent.multiGame
}
