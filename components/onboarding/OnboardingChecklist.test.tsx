import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { OnboardingChecklist } from './OnboardingChecklist'
import type { OnboardingState } from '@/lib/domain/onboarding'

afterEach(cleanup)

// usePathname() reads PathnameContext (next/dist/client/components/navigation),
// so providing it directly simulates App Router client navigation without
// module mocking.
function atPath(pathname: string, initial: OnboardingState) {
  return (
    <PathnameContext.Provider value={pathname}>
      <OnboardingChecklist initial={initial} />
    </PathnameContext.Provider>
  )
}

function checklist(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    enabled: true,
    dismissedAt: null,
    steps: [
      { id: 'settings', done: true },
      { id: 'inventory', done: false },
      { id: 'sale', done: false },
      { id: 'staff', done: false },
    ],
    ...overrides,
  }
}

const INVENTORY_LABEL = 'Add your first 5 cards (or import a CSV)'

test('refetches on navigation and ticks newly completed steps', async () => {
  let fetches = 0
  const refreshed = checklist({
    steps: checklist().steps.map(s => (s.id === 'inventory' ? { ...s, done: true } : s)),
  })
  global.fetch = (async () => {
    fetches++
    return { ok: true, json: async () => refreshed }
  }) as unknown as typeof fetch

  const view = render(atPath('/inventory', checklist()))

  // First paint is the server snapshot — no refetch, inventory still open.
  assert.equal(fetches, 0)
  assert.ok(screen.getByText(/3 steps to go/))
  assert.ok(!screen.getByText(INVENTORY_LABEL).className.includes('line-through'))

  // Client-side navigation (pathname change) triggers a refetch and the
  // newly completed step ticks off.
  view.rerender(atPath('/pos', checklist()))
  await waitFor(() => assert.equal(fetches, 1))
  await waitFor(() => {
    assert.ok(screen.getByText(INVENTORY_LABEL).className.includes('line-through'))
  })
  assert.ok(screen.getByText(/2 steps to go/))
})

test('re-rendering on the same pathname does not refetch', async () => {
  let fetches = 0
  global.fetch = (async () => {
    fetches++
    return { ok: true, json: async () => checklist() }
  }) as unknown as typeof fetch

  const view = render(atPath('/pos', checklist()))
  view.rerender(atPath('/pos', checklist()))
  assert.equal(fetches, 0)
})
