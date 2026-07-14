import { count, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { settings, inventoryItems, sales, staff } from '@/lib/db/schema'

// First-login onboarding checklist (spec §3.6). Enabled only where
// provisioning seeded settings.onboarding = '{}' — adopted Wizard-of-Oz and
// single-tenant shops keep null and never see it. Data-derived steps are
// computed live (no drift); the settings step is a stored manual mark.

export type OnboardingStepId = 'settings' | 'inventory' | 'sale' | 'staff'

export interface OnboardingState {
  enabled: boolean
  dismissedAt: string | null
  steps: { id: OnboardingStepId; done: boolean }[]
}

interface Stored {
  dismissedAt?: string
  completedAt?: string
  done?: OnboardingStepId[]
}

const DISABLED: OnboardingState = { enabled: false, dismissedAt: null, steps: [] }

export async function getOnboarding(dbc: Db = db): Promise<OnboardingState> {
  const [row] = await dbc.select({ onboarding: settings.onboarding }).from(settings).limit(1)
  if (!row?.onboarding) return DISABLED
  const stored = parseStored(row.onboarding)
  // Terminal states (dismissed, or previously completed) skip the live counts
  // for the rest of the shop's life and return no steps. completedAt doubles
  // as the hide signal so a finished checklist never renders or counts again.
  if (stored.dismissedAt || stored.completedAt) {
    return { enabled: true, dismissedAt: stored.dismissedAt ?? stored.completedAt ?? null, steps: [] }
  }
  const [[inv], [sal], [stf]] = await Promise.all([
    dbc.select({ n: count() }).from(inventoryItems),
    dbc.select({ n: count() }).from(sales),
    dbc.select({ n: count() }).from(staff),
  ])
  const steps: OnboardingState['steps'] = [
    { id: 'settings', done: stored.done?.includes('settings') ?? false },
    { id: 'inventory', done: inv.n >= 5 },
    { id: 'sale', done: sal.n >= 1 },
    { id: 'staff', done: stf.n >= 2 }, // beyond the admin created at setup
  ]
  if (steps.every(s => s.done)) {
    // One small write so every later call takes the terminal short-circuit
    // instead of re-counting. This call still returns the computed steps —
    // the card hides itself this render via remaining === 0.
    await patchStored(s => ({ ...s, completedAt: new Date().toISOString() }), dbc)
  }
  return { enabled: true, dismissedAt: null, steps }
}

export async function markOnboardingStep(step: 'settings', dbc: Db = db): Promise<void> {
  await patchStored(s => ({ ...s, done: [...new Set([...(s.done ?? []), step])] }), dbc)
}

export async function dismissOnboarding(dbc: Db = db): Promise<void> {
  await patchStored(s => ({ ...s, dismissedAt: new Date().toISOString() }), dbc)
}

async function patchStored(fn: (s: Stored) => Stored, dbc: Db): Promise<void> {
  const [row] = await dbc.select({ onboarding: settings.onboarding }).from(settings).limit(1)
  if (!row?.onboarding) return // disabled — no-op
  await dbc.update(settings)
    .set({ onboarding: JSON.stringify(fn(parseStored(row.onboarding))) })
    .where(eq(settings.id, 1))
}

function parseStored(raw: string): Stored {
  try {
    return JSON.parse(raw) as Stored
  } catch {
    return {}
  }
}
