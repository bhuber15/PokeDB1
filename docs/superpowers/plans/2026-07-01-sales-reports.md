# Date-Range Sales Reports & Margin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner pick a date range and see revenue, VAT, discounts, gross margin, payment-method breakdown, and top-selling cards for that range — not just "today."

**Architecture:** One new endpoint `GET /api/reports/sales?from=&to=` aggregates `sales`/`saleItems`/`inventoryItems` with Drizzle `sql` aggregates (same style already used in `app/api/sales/history/route.ts`). The existing Reports page gains a date-range picker that re-fetches this endpoint instead of (or alongside) the "today" stats already wired to `/api/sales/history`.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle, shadcn/ui + Tailwind v4.

## Global Constraints

- Node 24 LTS; Next.js 16 App Router only; TypeScript strict; no new npm dependencies.
- Money is SQLite `real`, GBP, 2dp. `round2 = (n) => Math.round(n * 100) / 100`.
- `createdAt` columns are stored as SQLite `datetime('now')` text: `"YYYY-MM-DD HH:MM:SS"` (UTC, space separator, no `T`/`Z`). Always compare against this exact format — a JS `toISOString()` string sorts incorrectly against it (see existing comment in `app/api/sales/history/route.ts:14-16`).
- Auth: sales reporting is admin/owner only — same guard used in `app/api/sales/history/route.ts` and `app/api/sales/route.ts` GET: `session.staffRole !== 'admin' && !session.isOwnerLoggedIn`.
- Reuse: `db` from `lib/db`, `getSession` from `lib/auth`, `formatGBP` from `lib/pricing` (display only — API returns raw numbers), schema tables from `lib/db/schema`.
- **Verification:** no unit-test runner is wired for API routes in this repo (`npm test` runs `node --import tsx --test "**/*.test.ts"` but no route tests exist today) — verify via `npx tsc --noEmit` (clean) plus the concrete `curl` check named in each task.

---

## File Structure

- `app/api/reports/sales/route.ts` — `GET` with `?from=&to=` query params → range summary (admin only).
- `components/reports/DateRangePicker.tsx` — small controlled component: two `<input type="date">` + preset buttons (Today / 7 days / 30 days / This month).
- `app/(app)/reports/page.tsx` — modified to add the range picker and a new "Range Summary" section fed by the new endpoint. The existing "today" stat cards and recent-sales list stay as-is.

---

## Task 1: Range summary endpoint

**Files:**
- Create: `app/api/reports/sales/route.ts`

**Interfaces:**
- Produces: `GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` → JSON:
  ```ts
  {
    range: { from: string; to: string }
    revenue: number       // sum(sales.total)
    subtotal: number      // sum(sales.subtotal)
    discountTotal: number // sum(sales.discountAmount)
    vatTotal: number      // sum(sales.vatAmount)
    grossMargin: number   // sum(saleItems.priceAtSale * qty) - sum(inventoryItems.costPrice * qty)
    saleCount: number
    byPaymentMethod: { paymentMethod: string; total: number }[]
    topCards: { cardId: number; name: string; quantitySold: number; revenue: number }[] // top 10 by quantitySold desc
  }
  ```
  Missing/invalid `from`/`to` → `400 { error: 'from and to (YYYY-MM-DD) are required' }`. `from > to` → `400 { error: 'from must be before to' }`.

- [ ] **Step 1:** Write the route:

```ts
// app/api/reports/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, saleItems, inventoryItems, cards } from '@/lib/db/schema'
import { and, gte, lt, eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be before to' }, { status: 400 })
  }

  // createdAt is "YYYY-MM-DD HH:MM:SS" text (UTC). Range is [from 00:00:00, to+1day 00:00:00).
  const fromTs = `${from} 00:00:00`
  const toTs = sql<string>`datetime(${to}, '+1 day')`
  const rangeWhere = and(gte(sales.createdAt, fromTs), lt(sales.createdAt, toTs))

  const [totals] = await db.select({
    revenue: sql<number>`COALESCE(SUM(total), 0)`,
    subtotal: sql<number>`COALESCE(SUM(subtotal), 0)`,
    discountTotal: sql<number>`COALESCE(SUM(discount_amount), 0)`,
    vatTotal: sql<number>`COALESCE(SUM(vat_amount), 0)`,
    saleCount: sql<number>`COUNT(*)`,
  }).from(sales).where(rangeWhere)

  const byPaymentMethod = await db.select({
    paymentMethod: sales.paymentMethod,
    total: sql<number>`COALESCE(SUM(total), 0)`,
  }).from(sales).where(rangeWhere).groupBy(sales.paymentMethod)

  const [marginRow] = await db.select({
    revenue: sql<number>`COALESCE(SUM(${saleItems.priceAtSale} * ${saleItems.quantity}), 0)`,
    cost: sql<number>`COALESCE(SUM(${inventoryItems.costPrice} * ${saleItems.quantity}), 0)`,
  })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .where(rangeWhere)

  const topCardsRaw = await db.select({
    cardId: inventoryItems.cardId,
    name: cards.name,
    quantitySold: sql<number>`COALESCE(SUM(${saleItems.quantity}), 0)`,
    revenue: sql<number>`COALESCE(SUM(${saleItems.priceAtSale} * ${saleItems.quantity}), 0)`,
  })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(rangeWhere)
    .groupBy(inventoryItems.cardId, cards.name)
    .orderBy(sql`SUM(${saleItems.quantity}) DESC`)
    .limit(10)

  const round2 = (n: number) => Math.round(n * 100) / 100

  return NextResponse.json({
    range: { from, to },
    revenue: round2(totals.revenue),
    subtotal: round2(totals.subtotal),
    discountTotal: round2(totals.discountTotal),
    vatTotal: round2(totals.vatTotal),
    grossMargin: round2(marginRow.revenue - marginRow.cost),
    saleCount: totals.saleCount,
    byPaymentMethod: byPaymentMethod.map(r => ({ ...r, total: round2(r.total) })),
    topCards: topCardsRaw
      .filter(r => r.cardId != null)
      .map(r => ({ cardId: r.cardId!, name: r.name ?? 'Unknown', quantitySold: r.quantitySold, revenue: round2(r.revenue) })),
  })
}
```

- [ ] **Step 2: Verify** with dev server + admin session:

```bash
curl -s -b '<cookie>' 'localhost:3000/api/reports/sales?from=2026-06-01&to=2026-06-30'
```
Expected: 200 with the JSON shape above; `saleCount` and `revenue` match what's visible in Reports "today" stats when `from=to=today`. Also check:
```bash
curl -s -b '<cookie>' 'localhost:3000/api/reports/sales?from=2026-07-01&to=2026-06-01'
```
Expected: `400 {"error":"from must be before to"}`.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/reports/sales/route.ts
git commit -m "feat: date-range sales report endpoint with gross margin"
```

---

## Task 2: Date range picker component

**Files:**
- Create: `components/reports/DateRangePicker.tsx`

**Interfaces:**
- Produces: `DateRangePicker({ from, to, onChange }: { from: string; to: string; onChange: (range: { from: string; to: string }) => void })` — renders two `<input type="date">` bound to `from`/`to`, plus four preset buttons (Today, 7 days, 30 days, This month) that each call `onChange` with computed ISO dates (`YYYY-MM-DD`, local browser date, no timezone library needed).

- [ ] **Step 1:** Write the component:

```tsx
// components/reports/DateRangePicker.tsx
'use client'
import { Button } from '@/components/ui/button'

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function preset(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - days)
  return { from: toISODate(from), to: toISODate(to) }
}

function thisMonth(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  return { from: toISODate(from), to: toISODate(now) }
}

interface Props {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
}

export function DateRangePicker({ from, to, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={from}
        max={to}
        onChange={e => onChange({ from: e.target.value, to })}
        className="border rounded px-2 py-1 text-sm"
      />
      <span className="text-muted-foreground text-sm">to</span>
      <input
        type="date"
        value={to}
        min={from}
        onChange={e => onChange({ from, to: e.target.value })}
        className="border rounded px-2 py-1 text-sm"
      />
      <div className="flex gap-1 ml-2">
        <Button size="sm" variant="outline" onClick={() => onChange(preset(0))}>Today</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(preset(7))}>7 days</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(preset(30))}>30 days</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(thisMonth())}>This month</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2:** `npx tsc --noEmit` clean; commit.

```bash
git add components/reports/DateRangePicker.tsx
git commit -m "feat: date range picker component for reports"
```

---

## Task 3: Wire range summary into Reports page

**Files:**
- Modify: `app/(app)/reports/page.tsx`

**Interfaces:**
- Consumes: `GET /api/reports/sales?from=&to=` (Task 1), `DateRangePicker` (Task 2).

- [ ] **Step 1:** In `app/(app)/reports/page.tsx`, add state for the range and a fetch effect, plus a new section rendered above "Recent Sales". Replace the file's top imports and add below the existing `TodayStats`/`RecentSale` interfaces:

```tsx
import { DateRangePicker } from '@/components/reports/DateRangePicker'

interface RangeSummary {
  range: { from: string; to: string }
  revenue: number
  subtotal: number
  discountTotal: number
  vatTotal: number
  grossMargin: number
  saleCount: number
  byPaymentMethod: { paymentMethod: string; total: number }[]
  topCards: { cardId: number; name: string; quantitySold: number; revenue: number }[]
}
```

Inside the component, add state and a loader (next to the existing `useState`/`useEffect` for `data`):

```tsx
  const todayISO = new Date().toISOString().slice(0, 10)
  const [range, setRange] = useState({ from: todayISO, to: todayISO })
  const [summary, setSummary] = useState<RangeSummary | null>(null)

  useEffect(() => {
    fetch(`/api/reports/sales?from=${range.from}&to=${range.to}`)
      .then(async res => (res.ok ? res.json() : null))
      .then(setSummary)
  }, [range.from, range.to])
```

Add a new section between the existing stat-card grid and the "Recent Sales" `<div>`:

```tsx
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Range Summary</h2>
          <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
        </div>
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Revenue', value: formatGBP(summary.revenue) },
              { label: 'Gross Margin', value: formatGBP(summary.grossMargin) },
              { label: 'VAT', value: formatGBP(summary.vatTotal) },
              { label: 'Sales', value: String(summary.saleCount) },
            ].map(stat => (
              <Card key={stat.label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {summary && summary.topCards.length > 0 && (
          <div className="border rounded-lg divide-y">
            {summary.topCards.map(c => (
              <div key={c.cardId} className="flex items-center justify-between p-3 text-sm">
                <span>{c.name}</span>
                <span className="text-muted-foreground">{c.quantitySold} sold · {formatGBP(c.revenue)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 2: Verify in browser:** open `/reports`, confirm the range picker defaults to today, switching to "30 days" updates the stat cards and top-cards list without a full page reload, and the numbers for "Today" match the existing "Today's Revenue" card above it.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add "app/(app)/reports/page.tsx"
git commit -m "feat: date-range summary with gross margin on Reports page"
```

---

## Self-Review Notes

- **Timestamp format:** range query builds `"YYYY-MM-DD 00:00:00"` boundaries and uses SQLite `datetime(to, '+1 day')` for the exclusive upper bound, matching the existing UTC-text convention documented in `app/api/sales/history/route.ts`. ✓
- **Margin correctness:** `grossMargin` uses `saleItems.priceAtSale` (price actually charged) minus `inventoryItems.costPrice` at time of query — note this reflects *current* cost basis if an item's cost was edited after the sale, not cost-at-sale-time. Out of scope: a `costPriceAtSale` snapshot column on `sale_items` would fix this permanently; flagged here as a known limitation, not silently hidden.
- **Auth:** matches existing admin-only guard exactly (`session.staffRole !== 'admin' && !session.isOwnerLoggedIn`). ✓
- **No new dependencies:** native `<input type="date">`, no date library. ✓
- Out of scope (noted): CSV export of this range view (covered by the separate CSV export/import plan); per-staff breakdown (can be added as another `groupBy` later if needed).
