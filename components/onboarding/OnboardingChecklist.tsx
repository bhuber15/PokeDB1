'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Circle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { OnboardingState, OnboardingStepId } from '@/lib/domain/onboarding'
// ^ type-only import: erased at compile, so no lib/db in the client bundle.

const STEP_META: Record<OnboardingStepId, { label: string; href: string }> = {
  settings: { label: 'Check your pricing margins and VAT scheme', href: '/settings' },
  inventory: { label: 'Add your first 5 cards (or import a CSV)', href: '/inventory' },
  sale: { label: 'Ring up a test sale', href: '/pos' },
  staff: { label: 'Add PINs for your staff', href: '/settings' },
}

export function OnboardingChecklist({ initial }: { initial: OnboardingState }) {
  const [state, setState] = useState(initial)
  if (!state.enabled || state.dismissedAt) return null
  const remaining = state.steps.filter(s => !s.done).length
  if (remaining === 0) return null

  async function dismiss() {
    setState({ ...state, dismissedAt: new Date().toISOString() })
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dismiss: true }),
    }).catch(() => {})
  }

  return (
    <div className="container mx-auto px-4 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Getting started</h2>
            <p className="text-sm text-muted-foreground">
              {remaining} step{remaining === 1 ? '' : 's'} to go — most shops are transacting within the hour.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss checklist">
            <X className="size-4" />
          </Button>
        </div>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {state.steps.map((s) => (
            <li key={s.id}>
              <Link href={STEP_META[s.id].href}
                className="flex items-center gap-2 text-sm hover:underline">
                {s.done
                  ? <CheckCircle2 className="size-4 text-green-600" aria-hidden />
                  : <Circle className="size-4 text-muted-foreground" aria-hidden />}
                <span className={s.done ? 'text-muted-foreground line-through' : ''}>{STEP_META[s.id].label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
