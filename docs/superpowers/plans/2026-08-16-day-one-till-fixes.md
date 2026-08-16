# Day-One Till Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four day-one readiness gaps before the pilot shop opens 2026-08-29: card refund tender, staff-workable returns desk, honest offline behaviour, and product buys on the buylist.

**Architecture:** Four independent slices in risk order — A: card refunds (no migration), B: staff returns (auth relaxation + role-gated Reports UI), C: offline hardening (banner + gating, no service worker), D: product buys (one migration on `buy_items`). Each slice is its own branch/PR; `main` stays shippable after each. Spec: `docs/superpowers/specs/2026-08-16-day-one-till-fixes-design.md`.

**Tech Stack:** Next.js App Router, Drizzle/libsql, zod, node:test + tsx (in-memory DB), @testing-library/react for components.

## Global Constraints

- All money is integer pence; no floats in domain/DB.
- Route handlers: `const db = await getTenantDb()`, pass to every domain call; never import the `db` singleton in a route.
- API routes wrap in `guarded()` and validate bodies with `parseBody()` + zod.
- Domain functions keep `dbc: Db = db` defaults; expected failures throw `DomainError(code, message)`.
- Client components never value-import `lib/domain/*` or anything touching `lib/db` (type imports fine).
- Schema change ⇒ `npx drizzle-kit generate` migration in the same commit. The live dev DB migration is applied later, as its own user-authorized step.
- Till endpoints keep accepting request shapes the offline queue may replay from before a deploy — do not rename/remove existing request fields.
- Run `npm test` from the repo root before declaring any task done.

---

## Slice A — card refund tender

### Task 1: Domain + API accept `card` refunds

**Files:**
- Modify: `lib/domain/refunds.ts:10` (input type), `:16` (METHODS)
- Modify: `app/api/refunds/route.ts:12` (zod enum)
- Modify: `lib/db/schema.ts` (refunds.method comment)
- Test: `lib/domain/refunds.test.ts`

**Interfaces:**
- Consumes: existing `createRefund(input, dbc)`, `getCashUpSummary(day, dbc)` from `lib/domain/reports.ts`.
- Produces: `CreateRefundInput['method']` widens to `'cash' | 'card' | 'store_credit'` — Task 2's UI relies on the route accepting `method: 'card'`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/domain/refunds.test.ts` (it already has `dbc`, `saleId`, `saleItemId`, `stockOf`, `domainCode` from its beforeEach — see the top of that file):

```ts
import { getCashUpSummary } from './reports'

test('card refund restocks and writes no credit-ledger row', async () => {
  const { amount } = await createRefund({
    staffId: 1, saleId, method: 'card', items: [{ saleItemId, quantity: 1 }],
  }, dbc)
  assert.equal(amount, 667) // same proportional maths as cash
  assert.equal(await stockOf(1), 3)
  const ledger = await dbc.select().from(schema.creditLedger)
  assert.equal(ledger.length, 0)
})

test('card refunds do not reduce the expected cash drawer', async () => {
  await createRefund({ staffId: 1, saleId, method: 'card', items: [{ saleItemId, quantity: 1 }] }, dbc)
  const day = new Date().toISOString().slice(0, 10) // UTC day, matches createdAt bucketing
  const summary = await getCashUpSummary(day, dbc)
  assert.equal(summary.cashRefunds, 0)       // the card refund is invisible to the drawer
  assert.equal(summary.cashSales, 2000)      // the cash sale from beforeEach still counts
})

test('residual cap holds across mixed-method refunds', async () => {
  await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  await createRefund({ staffId: 1, saleId, method: 'card', items: [{ saleItemId, quantity: 1 }] }, dbc)
  const { amount } = await createRefund({ staffId: 1, saleId, method: 'card', items: [{ saleItemId, quantity: 1 }] }, dbc)
  // 667 + 667 already refunded; cap = 2000 − 1334 = 666 (1p rounding absorbed by the cap)
  assert.equal(amount, 666)
  const rows = await dbc.select().from(schema.refunds)
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 2000) // never exceeds sale.total
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test lib/domain/refunds.test.ts`
Expected: the three new tests FAIL with `DomainError: Invalid method` (code `INVALID_INPUT`).

- [ ] **Step 3: Implement**

`lib/domain/refunds.ts` — two lines:

```ts
export interface CreateRefundInput {
  staffId: number
  saleId: number
  method: 'cash' | 'card' | 'store_credit'
  reason?: string
  items: { saleItemId: number; quantity: number }[]
  customerId?: number
}

// 'card' records that the terminal refunded the customer — PokeDB moves no
// money for it, exactly like card sales. Only 'cash' touches the drawer and
// only 'store_credit' touches the ledger.
const METHODS = new Set(['cash', 'card', 'store_credit'])
```

`app/api/refunds/route.ts:12`:

```ts
  method: z.enum(['cash', 'card', 'store_credit']),
```

`lib/db/schema.ts` (refunds table):

```ts
  method: text('method').notNull(), // 'cash' | 'card' | 'store_credit'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test lib/domain/refunds.test.ts`
Expected: ALL tests in the file PASS (pre-existing ones included).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/refunds.ts app/api/refunds/route.ts lib/db/schema.ts lib/domain/refunds.test.ts
git commit -m "Card refunds: record terminal refunds without corrupting the cash drawer"
```

### Task 2: Card button in the refund dialog

**Files:**
- Modify: `components/reports/RefundDialog.tsx:29` (state type), `:123-126` (buttons)

**Interfaces:**
- Consumes: `POST /api/refunds` now accepting `method: 'card'` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Widen the method state and add the button**

`components/reports/RefundDialog.tsx` — replace line 29:

```ts
  const [method, setMethod] = useState<'cash' | 'card' | 'store_credit'>('cash')
```

Replace the method-button row (lines 123–126):

```tsx
          <div className="flex gap-2">
            <Button size="sm" variant={method === 'cash' ? 'default' : 'outline'} onClick={() => setMethod('cash')}>Cash</Button>
            <Button size="sm" variant={method === 'card' ? 'default' : 'outline'} onClick={() => setMethod('card')}>Card</Button>
            <Button size="sm" variant={method === 'store_credit' ? 'default' : 'outline'} onClick={() => setMethod('store_credit')}>Store Credit</Button>
          </div>
          {method === 'card' && (
            <p className="text-xs text-muted-foreground">Refund the card on the terminal as usual — this records it.</p>
          )}
```

- [ ] **Step 2: Verify**

Run: `npm run lint && npm test`
Expected: clean. (No component test — the dialog's only new behaviour is a third value through the existing state; the domain behind it is covered by Task 1.)

- [ ] **Step 3: Commit**

```bash
git add components/reports/RefundDialog.tsx
git commit -m "Refund dialog: Card tender button"
```

---

## Slice B — staff can work the returns desk

### Task 3: Sales search matches product names

**Files:**
- Modify: `lib/domain/sales-search.ts:56-69`
- Test: Create `lib/domain/sales-search.test.ts`

**Interfaces:**
- Consumes: existing `searchSales(filters, dbc)`.
- Produces: product-name hits in the same `SaleSearchRow[]` shape — no signature change.

- [ ] **Step 1: Write the failing test**

Create `lib/domain/sales-search.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale } from './sales'
import { searchSales } from './sales-search'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  // A card sale (card 1 is seeded by seedBase; priced via cache)
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 1000 })
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, qrCode: 'qr-1',
  })
  await createSale({
    staffId: 1, items: [{ inventoryItemId: 1, quantity: 1 }],
    paymentMethod: 'cash', discount: 0, expectedTotal: 850,
  }, dbc)
  // A product sale (Coke can, priced by override — products always are)
  await dbc.insert(schema.products).values({ id: 1, name: 'Coke Zero 330ml', category: 'snacks' })
  await dbc.insert(schema.inventoryItems).values({
    id: 2, productId: 1, condition: 'NA', quantity: 10, costPrice: 50,
    sellPriceOverride: 150, qrCode: 'qr-2',
  })
  await createSale({
    staffId: 1, items: [{ inventoryItemId: 2, quantity: 1 }],
    paymentMethod: 'cash', discount: 0, expectedTotal: 150,
  }, dbc)
})

test('finds a sale by product name', async () => {
  const rows = await searchSales({ q: 'Coke' }, dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sale.total, 150)
  assert.match(rows[0].itemsSummary, /Coke Zero/)
})

test('receipt-number search still names product lines in the summary', async () => {
  const rows = await searchSales({ q: '2' }, dbc) // sale id 2 = the product sale
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sale.id, 2)
  assert.match(rows[0].itemsSummary, /1× Coke Zero 330ml/)
})
```

Note: `seedBase` seeds staff + card 1 — open `lib/db/test-helpers.ts` if a column name differs and adjust inserts, not assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/domain/sales-search.test.ts`
Expected: `finds a sale by product name` FAILS (0 rows — predicate is card-only).

- [ ] **Step 3: Implement**

`lib/domain/sales-search.ts` — inside the `if (q)` else-branch, add a product match and OR it in (the `products` import already exists):

```ts
      const pattern = `%${q}%`
      // Card-name match: any line of the sale is for a card whose name matches.
      const cardMatch = exists(
        dbc.select({ one: sql`1` })
          .from(saleItems)
          .innerJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
          .innerJoin(cards, eq(inventoryItems.cardId, cards.id))
          .where(and(eq(saleItems.saleId, sales.id), like(cards.name, pattern))),
      )
      // Product-name match: returning a drink shouldn't require the receipt number.
      const productMatch = exists(
        dbc.select({ one: sql`1` })
          .from(saleItems)
          .innerJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
          .innerJoin(products, eq(inventoryItems.productId, products.id))
          .where(and(eq(saleItems.saleId, sales.id), like(products.name, pattern))),
      )
      const customerMatch = exists(
        dbc.select({ one: sql`1` })
          .from(customers)
          .where(and(eq(customers.id, sales.customerId), like(customers.name, pattern))),
      )
      conditions.push(or(cardMatch, productMatch, customerMatch)!)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test lib/domain/sales-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/sales-search.ts lib/domain/sales-search.test.ts
git commit -m "Sales search matches product names on the returns desk"
```

### Task 4: Staff access to sales search + history; aggregates stay admin-only

**Files:**
- Modify: `app/api/sales/search/route.ts` (gate)
- Modify: `app/api/sales/history/route.ts` (gate + admin-only todayStats)
- Test: Create `tests/returns-authz.test.ts`

**Interfaces:**
- Consumes: `requireStaff` from `lib/auth.ts`; session's `staffRole`.
- Produces: `GET /api/sales/history` now returns `{ todayStats: TodayStats | null, recentSales }` — **null for staff**. Task 5's page must handle null.

- [ ] **Step 1: Write the failing policy test**

Create `tests/returns-authz.test.ts` (same static-guard style as `tests/tenancy-guard.test.ts`):

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Returns are a staff job by policy (spec 2026-08-16): the refund/void
// endpoints already allow staff, so the lookup endpoints that find the sale
// must too — an admin-only gate here silently makes returns owner-only at
// the counter. Aggregate reporting stays admin-only.
const STAFF_LOOKUP_ROUTES = [
  'app/api/sales/search/route.ts',
  'app/api/sales/history/route.ts',
]

test('sale-lookup routes gate on requireStaff, not requireAdmin', () => {
  for (const route of STAFF_LOOKUP_ROUTES) {
    const src = readFileSync(join(process.cwd(), route), 'utf8')
    assert.ok(src.includes('requireStaff('), `${route} must call requireStaff`)
    assert.ok(!src.includes('requireAdmin('), `${route} must not gate the whole handler behind requireAdmin`)
  }
})

test('aggregate report routes stay admin-only', () => {
  for (const route of [
    'app/api/reports/sales/route.ts',
    'app/api/reports/cash-up/route.ts',
    'app/api/sales/route.ts',
  ]) {
    const src = readFileSync(join(process.cwd(), route), 'utf8')
    assert.ok(src.includes('requireAdmin('), `${route} must keep requireAdmin`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/returns-authz.test.ts`
Expected: first test FAILS (both routes currently call requireAdmin).

- [ ] **Step 3: Implement**

`app/api/sales/search/route.ts` — swap the import and call:

```ts
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
```
```ts
  requireStaff(await getSession(await currentTenantId()))
```

`app/api/sales/history/route.ts` — staff get the list; today's revenue tiles are an aggregate, so they stay admin-only *in the payload*, not just the UI:

```ts
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
```

```ts
export const GET = guarded(async () => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))

  // createdAt is stored via SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, space separator).
  // Compare against the same format — a JS toISOString() ("...T...Z") sorts differently and would
  // silently exclude every sale.
  //
  // todayStats is revenue aggregation — admin-only, so it is withheld from the
  // payload for staff (redaction at the API edge, same as inventory costs).
  const todayStats = session.staffRole === 'admin'
    ? (await db.select({
        totalRevenue: sql<number>`COALESCE(SUM(total), 0)`,
        saleCount: sql<number>`COUNT(*)`,
        cashTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0)`,
        cardTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0)`,
      }).from(sales).where(and(isNull(sales.voidedAt), gte(sales.createdAt, sql`datetime('now','start of day')`))))[0]
    : null
```

(The rest of the handler — `recent`, `lines`, `itemsBySale`, the final `NextResponse.json({ todayStats, recentSales })` — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/returns-authz.test.ts && npm run lint`
Expected: PASS, no unused-import lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/sales/search/route.ts app/api/sales/history/route.ts tests/returns-authz.test.ts
git commit -m "Staff can find sales for returns; revenue aggregates stay admin-only"
```

### Task 5: Reports page renders by role

**Files:**
- Modify: `app/(app)/reports/page.tsx`

**Interfaces:**
- Consumes: `useStaffRole()` from `components/shared/SessionProvider.tsx`; `todayStats: TodayStats | null` from Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Gate the admin sections**

In `app/(app)/reports/page.tsx`:

1. Add the import and read the role at the top of `ReportsPage`:

```ts
import { useStaffRole } from '@/components/shared/SessionProvider'
```
```ts
export default function ReportsPage() {
  const role = useStaffRole()
```

2. Update the data state type so `todayStats` can be null:

```ts
  const [data, setData] = useState<{ todayStats: TodayStats | null; recentSales: RecentSale[] } | null>(null)
```

3. Skip the range-summary fetch for staff (the route 403s anyway — don't fire a doomed request):

```ts
  useEffect(() => {
    if (role !== 'admin') return
    fetch(`/api/reports/sales?from=${range.from}&to=${range.to}`)
      .then(async res => (res.ok ? res.json() : null))
      .then(setSummary)
  }, [range.from, range.to, role])
```

4. Wrap the admin-only blocks. The export buttons `<div className="flex gap-2">…</div>` in the header, the today-tiles grid, the whole "Range Summary" `<div className="space-y-3">…</div>`, `<CashUpSection />`, and `<StockSection />` each get an `{role === 'admin' && (…)}` wrapper. The today tiles additionally need the null guard:

```tsx
      {role === 'admin' && todayStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* …existing tiles unchanged… */}
        </div>
      )}
```

The page title, the sales search form, the recent-sales list, RefundDialog, VoidSaleDialog, and ReceiptDialog stay unconditional — that *is* the returns desk.

- [ ] **Step 2: Verify**

Run: `npm run lint && npx tsx --test tests/returns-authz.test.ts`
Then run the full suite: `npm test`
Expected: clean. Manual check happens in Slice-B review: log in with a staff PIN, open Reports — sales list + search + refund work; no tiles, no cash-up, no exports, no console errors.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/reports/page.tsx"
git commit -m "Reports page: staff see the returns desk, admins see the numbers"
```

---

## Slice C — offline: fail loudly and safely

### Task 6: App-wide offline banner

**Files:**
- Create: `components/shared/OfflineBanner.tsx`
- Test: Create `components/shared/OfflineBanner.test.tsx`
- Modify: `app/(app)/layout.tsx` (mount), `components/pos/OfflineChip.tsx` (stale comment)

**Interfaces:**
- Consumes: `useOnlineStatus()` from `components/shared/useOnlineStatus.ts`.
- Produces: nothing downstream; Tasks 7–8 rely only on the same hook.

- [ ] **Step 1: Write the failing test**

Create `components/shared/OfflineBanner.test.tsx` (pattern copied from `components/pos/OfflineChip.test.tsx`):

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { OfflineBanner } from './OfflineBanner'

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

test('renders nothing while online', () => {
  render(<OfflineBanner />)
  assert.equal(screen.queryByRole('status'), null)
})

test('appears offline with the honest capability summary, disappears online', () => {
  render(<OfflineBanner />)
  setNavigatorOnline(false)
  fireEvent.offline(window)
  const banner = screen.getByRole('status')
  assert.match(banner.textContent ?? '', /sales will queue/i)
  assert.match(banner.textContent ?? '', /search, buys and refunds need a connection/i)
  setNavigatorOnline(true)
  fireEvent.online(window)
  assert.equal(screen.queryByRole('status'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test components/shared/OfflineBanner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `components/shared/OfflineBanner.tsx`:

```tsx
'use client'
import { WifiOffIcon } from 'lucide-react'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'

// App-wide honesty bar for outages. States exactly what degrades: POS sales
// queue locally and replay (lib/sale-queue.ts); everything that needs the
// server — search, buys, refunds — waits. The POS keeps its local OfflineChip
// as the at-a-glance till indicator; this banner is the detailed version.
export function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-400/40 text-amber-600 dark:text-amber-400 text-sm font-medium"
    >
      <WifiOffIcon className="size-4 shrink-0" aria-hidden="true" />
      Offline — sales will queue and send when the connection returns. Search, buys and refunds need a connection.
    </div>
  )
}
```

Mount in `app/(app)/layout.tsx` — add the import and render it directly under `<Nav …/>` (above `BillingBanner`):

```tsx
import { OfflineBanner } from '@/components/shared/OfflineBanner'
```
```tsx
        <Nav
          shopName={settings.shopName}
          staffName={session.staffName}
          staffRole={session.staffRole}
          inStockWantsCount={inStockWantsCount}
        />
        <OfflineBanner />
```

Update the stale comment in `components/pos/OfflineChip.tsx` (lines 5–8):

```ts
// Shown in the POS header while the browser is offline. Purely informative:
// checkout still works offline via the sale queue (lib/sale-queue.ts); this
// chip makes that state visible right next to the basket. The app-wide
// OfflineBanner (components/shared/OfflineBanner.tsx) carries the full
// what-still-works summary.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test components/shared/OfflineBanner.test.tsx components/pos/OfflineChip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/shared/OfflineBanner.tsx components/shared/OfflineBanner.test.tsx "app/(app)/layout.tsx" components/pos/OfflineChip.tsx
git commit -m "App-wide offline banner states exactly what still works"
```

### Task 7: Honest gating on checkout, search, buys, refunds, voids

**Files:**
- Modify: `components/pos/CheckoutDialog.tsx` (queue-aware confirm, store-credit lock)
- Modify: `app/(app)/pos/page.tsx` (offline-aware search toast)
- Modify: `app/(app)/buylist/page.tsx` (offline-aware search toast)
- Modify: `components/buylist/BuyCart.tsx` (confirm disabled offline)
- Modify: `components/reports/RefundDialog.tsx`, `components/reports/VoidSaleDialog.tsx` (submit disabled offline)
- Test: Create `components/pos/CheckoutDialog.offline.test.tsx`

**Interfaces:**
- Consumes: `useOnlineStatus()`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `components/pos/CheckoutDialog.offline.test.tsx`. `useSettings` has a provider-less fallback (BuySlipDialog.test renders bare), so no wrapper is needed:

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CheckoutDialog } from './CheckoutDialog'

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

const item = { inventoryItemId: 1, name: 'Pikachu', condition: 'NM', quantity: 1, price: 850 }

test('offline: confirm reads Queue sale and store credit is locked', () => {
  setNavigatorOnline(false)
  render(<CheckoutDialog open items={[item as never]} onClose={() => {}} onConfirm={async () => {}} />)
  fireEvent.offline(window)
  assert.ok(screen.getByRole('button', { name: /queue sale/i }))
  const credit = screen.getByRole('button', { name: /store credit/i })
  assert.equal(credit.hasAttribute('disabled'), true)
})

test('online: confirm shows the total as before', () => {
  render(<CheckoutDialog open items={[item as never]} onClose={() => {}} onConfirm={async () => {}} />)
  assert.ok(screen.getByRole('button', { name: /confirm £8\.50/i }))
})
```

If `CartItem`'s real shape differs, fix the `item` literal against the type in `components/pos/` — not the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test components/pos/CheckoutDialog.offline.test.tsx`
Expected: first test FAILS (no "Queue sale" button).

- [ ] **Step 3: Implement CheckoutDialog**

In `components/pos/CheckoutDialog.tsx`:

```ts
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'
```

Inside the component:

```ts
  const online = useOnlineStatus()
```

Store-credit lock (balance is unverifiable offline — a queued credit sale could replay into a conflict after the customer left). In the single-tender method buttons, disable the `store_credit` option when `!online`; do the same for `store_credit` options in split rows, and if `method === 'store_credit'` when the connection drops the confirm gate below blocks submission. Add to the `confirmDisabled` expression:

```ts
    || (!online && usesStoreCredit)
```

Confirm button (footer, ~line 378):

```tsx
          <Button onClick={confirm} disabled={confirmDisabled} className="flex-1">
            {loading ? 'Processing…' : online ? `Confirm ${formatGBP(total)}` : `Queue sale ${formatGBP(total)}`}
          </Button>
```

And directly above the footer, the honest note:

```tsx
        {!online && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Offline — this sale will queue and send automatically when the connection returns.
            {usesStoreCredit && ' Store credit needs a connection to check the balance.'}
          </p>
        )}
```

- [ ] **Step 4: Offline-aware search failures (POS + buylist)**

`app/(app)/pos/page.tsx` — in `handleSearch`'s catch (~line 175):

```ts
    } catch {
      toast.error(navigator.onLine
        ? 'Network error — search failed'
        : 'Offline — search needs a connection. The basket and checkout still work.')
    } finally {
```

`app/(app)/buylist/page.tsx` — extend `handleSearch`'s catch (~line 62):

```ts
    } catch (e) {
      if (!navigator.onLine) {
        toast.error('Offline — buys need a connection and are not queued.')
      } else {
        toast.error(e instanceof Error && e.name === 'TimeoutError'
          ? 'Search timed out — please try again'
          : 'Search failed — please try again')
      }
    } finally {
```

- [ ] **Step 5: Disable buy/refund/void confirms offline**

Each gets the same three lines. `components/buylist/BuyCart.tsx`:

```ts
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'
```
```ts
  const online = useOnlineStatus()
```
```ts
  const canConfirm = lines.length > 0 && !creditRequiresCustomer && online
```
And under the total, next to the existing `creditRequiresCustomer` note:

```tsx
        {!online && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Offline — buys need a connection and are not queued.</p>
        )}
```

`components/reports/RefundDialog.tsx`: same import + `const online = useOnlineStatus()`, then:

```tsx
          <Button onClick={submit} disabled={loading || linesToRefund.length === 0 || missingCreditCustomer || !online} className="flex-1">
```
with `{!online && <p className="text-xs text-amber-600 dark:text-amber-400">Offline — refunds need a connection.</p>}` above the footer.

`components/reports/VoidSaleDialog.tsx`: same import + hook, then:

```tsx
          <Button variant="destructive" onClick={submit} disabled={loading || !online}>
```
with the matching one-line note above the footer (`Offline — voids need a connection.`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test components/pos/CheckoutDialog.offline.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/pos/CheckoutDialog.tsx components/pos/CheckoutDialog.offline.test.tsx "app/(app)/pos/page.tsx" "app/(app)/buylist/page.tsx" components/buylist/BuyCart.tsx components/reports/RefundDialog.tsx components/reports/VoidSaleDialog.tsx
git commit -m "Offline gating: queue-aware checkout, honest failures everywhere else"
```

### Task 8: Unload guard + wifi-down drill

**Files:**
- Modify: `lib/sale-queue.ts` (add `hasUnsentSales`), `app/(app)/pos/page.tsx` (beforeunload)
- Test: `lib/sale-queue.test.ts`
- Create: `docs/runbooks/wifi-down-drill.md`

**Interfaces:**
- Consumes: `readQueue` from `lib/sale-queue.ts`.
- Produces: `hasUnsentSales(queue: QueuedSale[]): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `lib/sale-queue.test.ts` (see its existing fake-Storage helper at the top of the file and reuse it):

```ts
test('hasUnsentSales: true only when a non-conflict entry exists', () => {
  assert.equal(hasUnsentSales([]), false)
  const sent = enqueueSale(body('a'), storage)
  assert.equal(hasUnsentSales(readQueue(storage)), true)
  setConflict(sent.clientUuid, { code: 'INSUFFICIENT_STOCK', error: 'gone' }, storage)
  assert.equal(hasUnsentSales(readQueue(storage)), false) // conflicts wait for a human, not a connection
})
```

(Adjust the `body('a')`/`storage` helper names to the file's existing ones — read its first 30 lines.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/sale-queue.test.ts`
Expected: FAIL — `hasUnsentSales` is not exported.

- [ ] **Step 3: Implement**

`lib/sale-queue.ts`:

```ts
// True while any queued sale still needs the network (conflicts don't — they
// wait for a human decision). Drives the POS's leave-page warning.
export function hasUnsentSales(queue: QueuedSale[]): boolean {
  return queue.some(e => !e.conflict)
}
```

`app/(app)/pos/page.tsx` — add `hasUnsentSales` to the existing `lib/sale-queue` import, then a new effect beside the replay effect:

```ts
  // localStorage keeps queued sales across a refresh, but a closed tab can't
  // replay them — warn before the tab goes away while anything is unsent.
  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (!hasUnsentSales(readQueue())) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test lib/sale-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the drill**

Create `docs/runbooks/wifi-down-drill.md`:

```markdown
# Wifi-down drill (till)

One page for the counter. Print it, tape it under the till.

## What just happened
The amber bar at the top means the till has lost the internet. The page you
are on keeps working; anything that needs the server does not.

## Keep selling — with two rules
- **Cash and card sales work.** Items already in the basket check out
  normally; the button says **Queue sale** instead of Confirm. The sale is
  saved on this machine and sends itself when the connection returns
  (a queued-sales panel appears on the POS until it drains).
- **Rule 1: don't close the tab and don't refresh.** Queued sales live in
  this browser tab's storage. The app warns you if you try to leave with
  unsent sales — heed it.
- **Rule 2: no store credit while offline.** The till can't check a balance,
  so store-credit payment is locked. Take cash or card, or ask the customer
  to come back.

## Paused until the connection returns
- **Search** (the catalogue lives on the server) — you can only sell what is
  already in the basket. Scan-by-QR also needs the server.
- **Buys** — do not buy cards or products in; nothing is queued for buys.
  Write the offer on paper and ring it when the bar clears.
- **Refunds and voids** — same. Note the receipt number, do it when back.

## When the amber bar clears
1. Watch the queued-sales panel drain (it retries every 30 seconds; each
   sends with a success message).
2. If an entry shows a conflict (e.g. stock ran out under a queued sale),
   it stays put with Retry/Discard — get the owner to resolve it.
3. Ring anything you wrote down on paper (buys, refunds).

## If it's been more than an hour
Phone the owner. Check the router before blaming the till: is other wifi
working? The till is fine — it will catch up the moment the network is back.
```

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/sale-queue.ts lib/sale-queue.test.ts "app/(app)/pos/page.tsx" docs/runbooks/wifi-down-drill.md
git commit -m "Unload guard for unsent queued sales + wifi-down drill for the counter"
```

---

## Slice D — buy non-card products on the buylist

### Task 9: Schema migration + domain product-buy path

**Files:**
- Modify: `lib/db/schema.ts` (buy_items.product_id)
- Create: `lib/db/migrations/0026_*.sql` (generated — do not hand-write)
- Modify: `lib/domain/buys.ts`
- Test: `lib/domain/buys.test.ts`

**Interfaces:**
- Consumes: `PRODUCT_CONDITION` from `lib/product-categories.ts`; unique partial index `inventory_items_product_id_unique`.
- Produces: `CreateBuyInput['items']` becomes `{ cardId?: number; productId?: number; condition?: string; quantity: number; payPrice: number }[]` — Task 10's route and Task 11's UI build on exactly this shape. New `DomainError` codes: `NOT_FOUND` (no such product), `PRODUCT_INACTIVE`.

- [ ] **Step 1: Schema + migration**

`lib/db/schema.ts`, in `buyItems` after `cardId`:

```ts
  // Exactly one of cardId/productId — enforced in createBuy (the domain choke
  // point), not by CHECK, same as inventory_items.
  productId: integer('product_id').references(() => products.id),
```

Run: `npx drizzle-kit generate`
Expected: a new `lib/db/migrations/0026_*.sql` containing `ALTER TABLE \`buy_items\` ADD \`product_id\` integer REFERENCES products(id);`. If your shell exports `TURSO_*` vars, unset them first (drizzle-kit gotcha — see AGENTS.md).

- [ ] **Step 2: Write the failing tests**

Append to `lib/domain/buys.test.ts` (reuse its existing `dbc`/seed helpers — read its beforeEach first; it seeds staff and cards like refunds.test.ts):

```ts
test('product buy increments the product stock row with weighted cost', async () => {
  await dbc.insert(schema.products).values({ id: 1, name: 'Booster Box SV', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 2, costPrice: 6000,
    sellPriceOverride: 9999, qrCode: 'qr-p1',
  })
  const { total } = await createBuy({
    staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 9000 }], method: 'cash',
  }, dbc)
  assert.equal(total, 9000)
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 50))
  assert.equal(row.quantity, 3)
  assert.equal(row.costPrice, 7000) // (6000×2 + 9000×1) / 3
  const [line] = await dbc.select().from(schema.buyItems)
  assert.equal(line.productId, 1)
  assert.equal(line.cardId, null)
  assert.equal(line.condition, 'NA')
  assert.equal(line.marketAtBuy, null) // no market price exists for products
})

test('mixed card + product buy in one transaction', async () => {
  await dbc.insert(schema.products).values({ id: 1, name: 'Sleeves 100ct', category: 'accessories' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 500, qrCode: 'qr-p1',
  })
  const { total } = await createBuy({
    staffId: 1,
    items: [
      { cardId: 1, condition: 'NM', quantity: 1, payPrice: 400 },
      { productId: 1, quantity: 2, payPrice: 100 },
    ],
    method: 'cash',
  }, dbc)
  assert.equal(total, 600)
  const lines = await dbc.select().from(schema.buyItems)
  assert.equal(lines.length, 2)
})

test('store-credit product buy writes the ledger', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.products).values({ id: 1, name: 'ETB Paldea', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 4500, qrCode: 'qr-p1',
  })
  await createBuy({
    staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 3000 }],
    method: 'store_credit', customerId: 1,
  }, dbc)
  const [entry] = await dbc.select().from(schema.creditLedger)
  assert.equal(entry.delta, 3000)
  assert.equal(entry.reason, 'buylist')
})

test('rejects a line with both ids, neither id, or an unknown/inactive product', async () => {
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ cardId: 1, productId: 1, condition: 'NM', quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ productId: 99, quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('NOT_FOUND'),
  )
  await dbc.insert(schema.products).values({ id: 1, name: 'Old Line', category: 'other' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 100, qrCode: 'qr-p1', isActive: false,
  })
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ productId: 1, quantity: 1, payPrice: 100 }], method: 'cash' }, dbc),
    domainCode('PRODUCT_INACTIVE'),
  )
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test lib/domain/buys.test.ts`
Expected: new tests FAIL (type errors on missing cardId are fine at runtime — tsx runs them; the domain throws `Invalid cardId`).

- [ ] **Step 4: Implement `lib/domain/buys.ts`**

New input type + validation (replacing lines 9–15 and the per-item checks at 34–39):

```ts
import { PRODUCT_CONDITION } from '@/lib/product-categories'

export interface CreateBuyInput {
  staffId: number
  staffRole?: 'admin' | 'staff'
  // Exactly one of cardId/productId per line. condition is required for card
  // lines; product lines have none (stored as PRODUCT_CONDITION) — a battered
  // box is priced lower, not graded.
  items: { cardId?: number; productId?: number; condition?: string; quantity: number; payPrice: number }[]
  method: 'cash' | 'store_credit'
  customerId?: number
}
```

```ts
  for (const it of input.items) {
    if ((it.cardId == null) === (it.productId == null)) {
      throw new DomainError('INVALID_INPUT', 'Each line needs exactly one of cardId or productId')
    }
    if (it.cardId != null) {
      if (!Number.isInteger(it.cardId) || it.cardId < 1) throw new DomainError('INVALID_INPUT', 'Invalid cardId')
      if (!it.condition || !CONDITION_SET.has(it.condition)) throw new DomainError('INVALID_INPUT', 'Invalid condition')
    } else if (!Number.isInteger(it.productId) || it.productId! < 1) {
      throw new DomainError('INVALID_INPUT', 'Invalid productId')
    }
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    if (!Number.isInteger(it.payPrice) || it.payPrice < 0) throw new DomainError('INVALID_INPUT', 'Invalid pay price')
  }
```

Market snapshot + cap loop become card-only (drizzle's `inArray` breaks on `[]`, so guard):

```ts
  const cardLines = input.items.filter(i => i.cardId != null)
  const cardIds = [...new Set(cardLines.map(i => i.cardId!))]
  const cacheRows = cardIds.length
    ? await dbc.select().from(priceCache).where(inArray(priceCache.cardId, cardIds))
    : []
  const settings = await getSettings(dbc)
  const marketByCard = new Map<number, number | null>(
    cardIds.map(id => [id, pickMarketPrice(cacheRows.find(r => r.cardId === id), settings.primaryPriceSource)]),
  )
  for (const it of cardLines) {
    // …existing cap block unchanged, it already reads it.cardId/it.condition…
  }
```

(Inside the cap block change nothing except `it.condition` → `it.condition!`.)

Intake loop — the card branch is today's code verbatim; add the product branch:

```ts
    for (const it of input.items) {
      let inventoryItemId: number
      if (it.cardId != null) {
        // …existing card merge/insert block, unchanged, with it.condition! …
      } else {
        // Products own exactly one stock row (partial unique index), created by
        // createProduct — a missing row means the id is bogus, not "make one".
        const [row] = await tx.select().from(inventoryItems)
          .where(eq(inventoryItems.productId, it.productId!)).limit(1)
        if (!row) throw new DomainError('NOT_FOUND', 'Product not found')
        if (!row.isActive) {
          throw new DomainError('PRODUCT_INACTIVE', 'This product is deactivated — reactivate it in Inventory before buying it in')
        }
        const newQty = row.quantity + it.quantity
        const newCost = Math.round(((row.costPrice ?? 0) * row.quantity + it.payPrice * it.quantity) / newQty)
        await tx.update(inventoryItems)
          .set({ quantity: newQty, costPrice: newCost })
          .where(eq(inventoryItems.id, row.id))
        inventoryItemId = row.id
      }

      await tx.insert(buyItems).values({
        buyId: buy.id,
        cardId: it.cardId ?? null,
        productId: it.productId ?? null,
        inventoryItemId,
        condition: it.cardId != null ? it.condition! : PRODUCT_CONDITION,
        quantity: it.quantity,
        payPrice: it.payPrice,
        marketAtBuy: it.cardId != null ? marketByCard.get(it.cardId) ?? null : null,
      })
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test lib/domain/buys.test.ts && npm test`
Expected: all pass (full suite catches any caller the type change broke).

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations lib/domain/buys.ts lib/domain/buys.test.ts
git commit -m "Buylist domain: buy non-card products into their stock row (migration 0026)"
```

### Task 10: Buys API + CSV export know about products

**Files:**
- Modify: `app/api/buys/route.ts` (zod)
- Modify: `lib/domain/reports.ts` (`getBuyExportRows` + `BuyExportRow`)
- Modify: `app/api/buys/export/route.ts` (column)
- Test: `lib/domain/reports.test.ts` (or create `lib/domain/reports.buys.test.ts` if reports.test.ts doesn't exist)

**Interfaces:**
- Consumes: Task 9's `CreateBuyInput`.
- Produces: `BuyExportRow.itemName` (replaces `cardName`); CSV column header `item` (replaces `card`).

- [ ] **Step 1: Write the failing test**

In the reports test file (create with the standard `createTestDb`/`seedBase` beforeEach from `lib/domain/refunds.test.ts` if absent):

```ts
test('buy export rows name products as well as cards', async () => {
  await dbc.insert(schema.products).values({ id: 1, name: 'Booster Box SV', category: 'sealed' })
  await dbc.insert(schema.inventoryItems).values({
    id: 50, productId: 1, condition: 'NA', quantity: 0, costPrice: null,
    sellPriceOverride: 9999, qrCode: 'qr-p1',
  })
  await createBuy({
    staffId: 1,
    items: [
      { cardId: 1, condition: 'NM', quantity: 1, payPrice: 400 },
      { productId: 1, quantity: 1, payPrice: 9000 },
    ],
    method: 'cash',
  }, dbc)
  const rows = await getBuyExportRows(dbc)
  const names = rows.map(r => r.itemName).sort()
  assert.ok(names.includes('Booster Box SV'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test <the reports test file>`
Expected: FAIL — `itemName` doesn't exist (and the product row's `cardName` would be null).

- [ ] **Step 3: Implement**

`lib/domain/reports.ts` — in `BuyExportRow`, rename `cardName: string | null` → `itemName: string | null`. In `getBuyExportRows`, replace the `cardName: cards.name,` select field and add the join (`products` is already imported at line 11):

```ts
      itemName: sql<string | null>`COALESCE(${cards.name}, ${products.name})`,
```
```ts
    .leftJoin(cards, eq(buyItems.cardId, cards.id))
    .leftJoin(products, eq(buyItems.productId, products.id))
```

`app/api/buys/export/route.ts` — header `'card'` → `'item'`, and `r.cardName` → `r.itemName`.

`app/api/buys/route.ts` — replace `createBuyBody`:

```ts
const buyLine = z.object({
  cardId: z.number().int().positive().optional(),
  productId: z.number().int().positive().optional(),
  condition: z.string().optional(),
  quantity: z.number().int(),
  payPrice: z.number().int().nonnegative(), // pence
}).refine(l => (l.cardId == null) !== (l.productId == null), {
  message: 'Each line needs exactly one of cardId or productId',
})

const createBuyBody = z.object({
  items: z.array(buyLine).default([]),
  method: z.enum(['cash', 'store_credit']),
  customerId: z.number().int().optional(),
})
```

(The old `{ cardId, condition, … }` shape still parses — replay-compatibility holds.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/buys/route.ts lib/domain/reports.ts app/api/buys/export/route.ts lib/domain/reports*.test.ts
git commit -m "Buys API + CSV export carry product lines"
```

### Task 11: Buylist UI: search, cart and slip for products

**Files:**
- Create: `components/buylist/ProductBuyRow.tsx`
- Modify: `app/(app)/buylist/page.tsx`, `components/buylist/BuyCart.tsx`, `components/buylist/BuySlipDialog.tsx`
- Test: Create `components/buylist/ProductBuyRow.test.tsx`; extend `components/buylist/BuySlipDialog.test.tsx`

**Interfaces:**
- Consumes: `GET /api/inventory?q=` (bare array of `{ item, card, product, prices }`; product rows have `product != null` — includes the EAN fast-path); Task 9/10 request shape.
- Produces: `BuyCartLine` becomes `{ cardId?: number; productId?: number; cardName: string; condition?: string; quantity: number; payPriceCash: number | null; payPriceCredit: number | null }`.

- [ ] **Step 1: Write the failing test**

Create `components/buylist/ProductBuyRow.test.tsx`:

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ProductBuyRow } from './ProductBuyRow'

afterEach(cleanup)

const product = { id: 1, name: 'Booster Box SV', category: 'sealed', ean: '5060000000017', createdAt: '' }

test('adds a product line with the typed pay price in pence, no condition', () => {
  let line: unknown
  render(<ProductBuyRow product={product as never} onAdd={l => { line = l }} />)
  fireEvent.change(screen.getByLabelText(/pay price/i), { target: { value: '90.00' } })
  fireEvent.click(screen.getByRole('button', { name: /add/i }))
  assert.deepEqual(line, {
    productId: 1, cardName: 'Booster Box SV', quantity: 1,
    payPriceCash: 9000, payPriceCredit: 9000,
  })
})

test('blocks add until a price is typed', () => {
  render(<ProductBuyRow product={product as never} onAdd={() => {}} />)
  const btn = screen.getByRole('button', { name: /add/i })
  assert.equal(btn.hasAttribute('disabled'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test components/buylist/ProductBuyRow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProductBuyRow**

Create `components/buylist/ProductBuyRow.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { parsePounds } from '@/lib/pricing'
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from '@/lib/product-categories'
import type { Product } from '@/lib/db/schema'
import type { BuyCartLine } from './BuyCart'

// Buying a product in: no condition ladder, no market offer — the pay price
// is the whole judgement (a battered box gets a lower offer, not a grade).
// Cash and credit prices are the same number: with no market reference there
// is nothing for the cash/credit percentages to derive from.
export function ProductBuyRow({ product, onAdd }: { product: Product; onAdd: (line: BuyCartLine) => void }) {
  const [qty, setQty] = useState(1)
  const [price, setPrice] = useState('')
  const pence = price ? parsePounds(price) : null
  const valid = pence != null && pence >= 0 && qty >= 1

  return (
    <div className="border rounded-xl p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{product.name}</div>
        <div className="text-sm text-muted-foreground flex gap-2 items-center">
          <Badge variant="outline" className="text-xs py-0">
            {PRODUCT_CATEGORY_LABELS[product.category as ProductCategory] ?? product.category}
          </Badge>
          {product.ean && <span className="text-xs">{product.ean}</span>}
        </div>
      </div>
      <Input
        aria-label="Quantity"
        type="number" min={1} value={qty}
        onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
        className="w-16 text-right"
      />
      <Input
        aria-label="Pay price (£ each)"
        type="number" inputMode="decimal" step="0.01" min="0" placeholder="£ each"
        value={price} onChange={e => setPrice(e.target.value)}
        className="w-24 text-right"
      />
      <Button
        disabled={!valid}
        onClick={() => valid && onAdd({
          productId: product.id, cardName: product.name, quantity: qty,
          payPriceCash: pence, payPriceCredit: pence,
        })}
      >
        Add
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Loosen BuyCartLine and send the right ids**

`components/buylist/BuyCart.tsx` — replace the type (drop the `extends`):

```ts
export interface BuyCartLine {
  cardId?: number
  productId?: number
  cardName: string // display name — card or product
  condition?: string // card lines only
  quantity: number
  payPriceCash: number | null
  payPriceCredit: number | null
}
```

In `handleConfirm`, the items map becomes id-aware:

```ts
          items: lines.map(l => ({
            ...(l.cardId != null
              ? { cardId: l.cardId, condition: l.condition }
              : { productId: l.productId }),
            quantity: l.quantity,
            payPrice: method === 'cash' ? (l.payPriceCash ?? 0) : (l.payPriceCredit ?? 0),
          })),
```

The success toast counts "cards" — make it neutral: `` toast.success(`Bought ${cardCount} item${cardCount !== 1 ? 's' : ''} for ${formatGBP(confirmedTotal)}`) ``.

In the line renderer, only show the condition badge when present:

```tsx
                  {line.condition && <Badge variant="outline" className="text-xs py-0">{line.condition}</Badge>}
```

And in the slip snapshot inside `handleConfirm`: `condition: l.condition ?? 'NA',`.

`components/buylist/BuySlipDialog.tsx` — in `slipHtml`, wherever a line's condition is printed, skip the `'NA'` sentinel (render the condition text only when `line.condition !== 'NA'`). Labels: `printLabelSheet` is card-shaped — build the `LabelData` list from card lines only (filter `condition !== 'NA'` is not enough; filter on the slip line coming from a card — pass `productId` through `BuySlipData['lines']` entries as an optional field and filter `l.productId == null`).

- [ ] **Step 5: Product results on the buylist page**

`app/(app)/buylist/page.tsx`:

```ts
import { ProductBuyRow } from '@/components/buylist/ProductBuyRow'
import type { Product } from '@/lib/db/schema'
```

State + fetch (in `handleSearch`, run both lookups in parallel):

```ts
  const [productResults, setProductResults] = useState<Product[]>([])
```

```ts
      const gameQ = gameFilter !== 'all' ? `&game=${gameFilter}` : ''
      const [res, invRes] = await Promise.all([
        fetch(`/api/cards/search?q=${encodeURIComponent(q)}${gameQ}`, { signal: AbortSignal.timeout(15_000) }),
        fetch(`/api/inventory?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) }),
      ])
      const invRows: { product: Product | null }[] = invRes.ok ? await invRes.json() : []
      setProductResults(invRows.filter(r => r.product != null).map(r => r.product!))
```

Adjust the no-results branch to also consider products (`if (!cards.length && !productRows.length)`), and render products above the card results:

```tsx
        {productResults.map(p => (
          <ProductBuyRow key={`p-${p.id}`} product={p} onAdd={handleAdd} />
        ))}
```

(`handleAdd` already takes a `BuyCartLine`; card `onAdd` still spreads `cardName` in.)

- [ ] **Step 6: Extend the slip test**

Append to `components/buylist/BuySlipDialog.test.tsx`:

```tsx
test('product lines print without a condition', async () => {
  render(<BuySlipDialog
    slip={slip({ lines: [{ cardName: 'Booster Box SV', condition: 'NA', quantity: 1, payPrice: 9000, productId: 1 } as never] })}
    onClose={() => {}}
  />)
  await screen.findByText(/Booster Box SV/)
  assert.equal(screen.queryByText(/\bNA\b/), null)
})
```

(If the dialog body doesn't render line conditions outside `slipHtml`, assert on the dialog's visible line list instead — the invariant is: no visible literal `NA`.)

- [ ] **Step 7: Run tests + gate**

Run: `npx tsx --test components/buylist/ProductBuyRow.test.tsx components/buylist/BuySlipDialog.test.tsx && npm test && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add components/buylist/ProductBuyRow.tsx components/buylist/ProductBuyRow.test.tsx components/buylist/BuyCart.tsx components/buylist/BuySlipDialog.tsx components/buylist/BuySlipDialog.test.tsx "app/(app)/buylist/page.tsx"
git commit -m "Buylist UI: buy sealed/accessories/snacks in, condition-less"
```

---

## After all slices

- Each slice merges via its own PR (finishing-a-development-branch skill). Full gate per slice: `npm test && npm run lint && npm run test:e2e` (remember the cold-worktree e2e warmup gotcha).
- Migration 0026 (Slice D) is applied to the live dev DB as a separate user-authorized step after that PR merges — deploys never auto-migrate.
- The wifi-down drill gets printed and taped under the till (user-side).
