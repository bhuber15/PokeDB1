# Counter Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the POS visibly offline-aware and usable on tablets before shop demos, per `docs/superpowers/specs/2026-07-26-counter-readiness-design.md`.

**Architecture:** Two independent, presentational-only changes: (1) an amber "Offline" chip on the POS page driven by a reusable `useOnlineStatus` hook; (2) responsive fixes to the top nav and POS grid verified live at tablet viewports. No domain, API, or schema changes.

**Tech Stack:** Next.js App Router, React 19, Tailwind v4, lucide-react icons, node:test + @testing-library/react (jsdom via `tests/dom-setup.ts`, already wired into `npm test`).

## Global Constraints

- No changes under `lib/domain/`, `app/api/`, or `lib/db/` — this package is UI-only.
- Client components never value-import from `lib/domain/` or anything touching `lib/db` (repo rule; the new files import neither).
- Desktop layout at ≥1280 px must be visually unchanged (the Playwright e2e runs there).
- UK English copy. Chip text is exactly: `Offline — sales will queue`
- The chip must never block selling: it renders state, it does not gate checkout (the sale queue in `lib/sale-queue.ts` already handles offline checkout).

---

### Task 1: Offline status chip on the POS page

**Files:**
- Create: `components/shared/useOnlineStatus.ts`
- Create: `components/pos/OfflineChip.tsx`
- Create: `components/pos/OfflineChip.test.tsx`
- Modify: `app/(app)/pos/page.tsx` (header row, around line 315–319)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `useOnlineStatus(): boolean` (exported named hook) and `OfflineChip(): JSX.Element | null` (exported named component, self-contained — renders `null` while online). Task 2 does not depend on either, but verifies the chip visually at tablet sizes.

> **Amended 2026-07-26 after first execution.** Two toolchain conflicts in the original
> snippets: (1) `new Event('offline')` fails under the repo's jsdom bootstrap —
> `tests/`/`components/test-helpers.tsx` doesn't alias `global.Event`, so Node 24's
> native `Event` is rejected by jsdom's dispatch; use testing-library's
> `fireEvent.offline(window)` / `fireEvent.online(window)` and stub `navigator.onLine`.
> (2) `setOnline(navigator.onLine)` inside `useEffect` trips Next 16's
> `react-hooks/set-state-in-effect`; the hook is instead built on
> `useSyncExternalStore` (mirroring `components/shared/useStickyGameFilter.ts`).
> The code blocks below are the amended versions and match what shipped.

- [ ] **Step 1: Write the failing test**

Create `components/pos/OfflineChip.test.tsx`:

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { OfflineChip } from './OfflineChip'

// jsdom pins navigator.onLine at true and doesn't flip it for dispatched
// events, so shadow the getter per-test; the hook's snapshot reads it on
// each online/offline notification.
function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

test('renders nothing while online', () => {
  render(<OfflineChip />)
  assert.equal(screen.queryByText(/Offline — sales will queue/), null)
})

test('appears on the offline event and disappears on online', () => {
  render(<OfflineChip />)
  setNavigatorOnline(false)
  fireEvent.offline(window)
  assert.ok(screen.getByText('Offline — sales will queue'))
  setNavigatorOnline(true)
  fireEvent.online(window)
  assert.equal(screen.queryByText(/Offline — sales will queue/), null)
})

test('is announced politely to screen readers', () => {
  render(<OfflineChip />)
  act(() => { fireEvent(window, new Event('offline')) })
  const chip = screen.getByRole('status')
  assert.match(chip.textContent ?? '', /Offline — sales will queue/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "" components/pos/OfflineChip.test.tsx` — if the runner rejects a path filter, run `npm test` and look for the OfflineChip failures.
Expected: FAIL — `Cannot find module './OfflineChip'`.

- [ ] **Step 3: Implement the hook**

Create `components/shared/useOnlineStatus.ts`:

```ts
'use client'
import { useSyncExternalStore } from 'react'

// Online tracker on useSyncExternalStore (same shape as useStickyGameFilter):
// the snapshot is navigator.onLine, re-read whenever the window online/offline
// events fire. The server snapshot is `true`, so SSR and hydration assume
// online and the browser corrects itself immediately after mount.
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
}
```

- [ ] **Step 4: Implement the chip**

Create `components/pos/OfflineChip.tsx`:

```tsx
'use client'
import { WifiOffIcon } from 'lucide-react'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'

// Shown in the POS header while the browser is offline. Purely informative:
// checkout still works offline via the sale queue (lib/sale-queue.ts); this
// chip just makes that state visible to staff. POS-only on purpose — other
// pages have no offline queue, so a global chip would overpromise.
export function OfflineChip() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 h-12 px-3 rounded-xl border border-amber-400/40 bg-amber-400/5 text-amber-500 text-xs font-medium shrink-0"
    >
      <WifiOffIcon className="size-3.5" aria-hidden="true" />
      Offline — sales will queue
    </div>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test` (filtered run if supported).
Expected: all three OfflineChip tests PASS; no other tests broken.

- [ ] **Step 6: Wire the chip into the POS header**

In `app/(app)/pos/page.tsx`, add the import next to the other component imports:

```tsx
import { OfflineChip } from '@/components/pos/OfflineChip'
```

and render it in the header row between the search bar and the game filter (the row currently reads `SearchBar` in a flex-1 div, then `GameFilter`):

```tsx
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <SearchBar onSearch={handleSearch} onQRDetected={handleQRDetected} loading={loading} />
          </div>
          <OfflineChip />
          <GameFilter value={gameFilter} onChange={setGameFilter} />
        </div>
```

- [ ] **Step 7: Full test + lint**

Run: `npm test && npm run lint`
Expected: PASS / no new lint errors.

- [ ] **Step 8: Commit**

```bash
git add components/shared/useOnlineStatus.ts components/pos/OfflineChip.tsx components/pos/OfflineChip.test.tsx "app/(app)/pos/page.tsx"
git commit -m "feat: offline status chip on POS (visible sale-queue state)"
```

---

### Task 2: Tablet pass — nav + POS grid at 768×1024 / 1024×768

Browser-verified task: run the dev server against the local sandbox DB and audit before/after at both orientations. (Worktree note: copy `.env.local` from the main checkout — it is gitignored and already points at `local-sandbox.db`; staff PIN 1234.)

**Files:**
- Modify: `components/layout/Nav.tsx` (link render, ~lines 52–73)
- Modify: `app/(app)/pos/page.tsx` (outer grid, ~line 312)

**Interfaces:**
- Consumes: `OfflineChip` from Task 1 (visual verification only).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Baseline audit**

Start the dev server, sign in with the staff PIN, open `/pos` and resize to 768×1024 and 1024×768. Screenshot both. Confirm the two expected defects: admin nav links overflow the viewport width, and the fixed 360 px cart column crowds results at 768 px. Note anything else (dialogs, sale-queue panel).

- [ ] **Step 2: Nav — icon-only links below `lg`**

In `components/layout/Nav.tsx`, wrap the label text in a responsive span and give the link an accessible name + tooltip that survive icon-only mode:

```tsx
              <Link
                key={l.href}
                href={l.href}
                title={l.label}
                aria-label={l.label}
                className={`flex items-center gap-1.5 px-4 max-lg:px-3 h-14 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span className="hidden lg:inline">{l.label}</span>
                {l.badge && l.badge > 0 ? (
                  <Badge
                    className="ml-1 max-lg:ml-0 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                    aria-label={`${l.badge} wanted cards in stock`}
                  >
                    {l.badge}
                  </Badge>
                ) : null}
              </Link>
```

- [ ] **Step 3: POS grid — responsive columns + dvh height**

In `app/(app)/pos/page.tsx`, replace the outer wrapper:

```tsx
    <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] xl:grid-cols-[1fr_360px] gap-6 md:h-[calc(100dvh-120px)]">
```

(dropping the inline `style` — the height moves into the class, `dvh` so iPad Safari's collapsing toolbars don't hide the cart; no fixed height below `md` where the columns stack).

- [ ] **Step 4: Live verification at both orientations**

Reload at 768×1024 and 1024×768: nav fits without horizontal scroll; results + cart both visible and scrollable; run a full sale (search → add → checkout dialog → receipt dialog) at 768 wide; toggle offline (DevTools/event) to see the chip and queue panel placement. Screenshot both orientations. Then resize to 1280×800 and confirm desktop is unchanged (labels back, 360 px cart).

- [ ] **Step 5: Full test + lint + e2e**

Run: `npm test && npm run lint`, then `npm run test:e2e` twice if the first run hits the fresh-worktree cold-compile timeout (known gotcha — first run is a throwaway cache-warmer).
Expected: unit + lint clean; e2e checkout smoke green on the warm run.

- [ ] **Step 6: Commit**

```bash
git add components/layout/Nav.tsx "app/(app)/pos/page.tsx"
git commit -m "fix: tablet-width nav and POS layout (icon nav below lg, responsive cart column, dvh height)"
```
