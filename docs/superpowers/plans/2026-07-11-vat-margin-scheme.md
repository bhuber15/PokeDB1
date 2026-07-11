# VAT Margin Scheme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the UK VAT Margin Scheme (VAT on the per-line margin of second-hand goods) to PokeDB's pricing, sales, settings, receipts, and reporting.

**Architecture:** Margin VAT is *VAT-inclusive*, so the customer total under `margin` equals `none`. `computeSaleTotals` stays the client-safe customer-total function; a new server-only pure `computeMarginVat` computes the VAT owed per line from `cost_at_sale`. `createSale` stores that figure in `sales.vat_amount` (uniform "VAT owed to HMRC" across schemes) and returns a no-cost-line count so the till can warn without cost ever reaching the browser. No-cost lines are handled per a new per-shop setting; a stock-book CSV export satisfies the legal record.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Drizzle ORM + SQLite/Turso, node:test via tsx, Tailwind v4.

**Design spec:** `docs/superpowers/specs/2026-07-11-vat-margin-scheme-design.md`

## Global Constraints

- **All money is integer pence (GBP).** No floats in DB/domain; convert to pounds only at the UI/CSV edge.
- **Prices are server-canonical.** The client never sends prices; margin VAT is computed server-side.
- **Client-bundle boundary:** client components never value-import from `lib/domain/` or `lib/db` (`import type` only). `computeMarginVat` is pure and must not be imported by any client component. `lib/pricing.ts` stays dependency-free.
- **VAT rate lives in one named constant** (`VAT_RATE = 0.2`) — no scattered `0.2` / `1/6` magic numbers.
- **Rounding:** margin VAT rounded **per line** with `Math.round`.
- **Changed behaviour needs a colocated `*.test.ts`.**
- **Verification gate (all green before done):** `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
- **Migration:** generate with `npx drizzle-kit generate`; applying to the live DB is the user's step (deploy does not auto-migrate).

---

### Task 1: VAT rate constants + `margin` case in `computeSaleTotals`

**Files:**
- Modify: `lib/pricing.ts:64-73`
- Test: `lib/pricing.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `export const VAT_RATE = 0.2`
  - `export const MARGIN_VAT_DIVISOR` (= 6; derived from `VAT_RATE`)
  - `computeSaleTotals(subtotalPence: number, discountPence: number, vatScheme: 'none' | 'standard' | 'margin'): { discount: number; vatAmount: number; total: number }` — for `margin`, `vatAmount` is `0` and `total` is `afterDiscount` (identical to `none`).

- [ ] **Step 1: Write the failing test**

Add to `lib/pricing.test.ts` (below the existing `computeSaleTotals` tests):

```ts
test('computeSaleTotals: margin scheme behaves like none for the customer total (VAT-inclusive)', () => {
  assert.deepEqual(computeSaleTotals(1700, 0, 'margin'), { discount: 0, vatAmount: 0, total: 1700 })
  assert.deepEqual(computeSaleTotals(1700, 200, 'margin'), { discount: 200, vatAmount: 0, total: 1500 })
})

test('VAT_RATE and MARGIN_VAT_DIVISOR are the single source of the rate', () => {
  assert.equal(VAT_RATE, 0.2)
  assert.equal(MARGIN_VAT_DIVISOR, 6)
})
```

Update the import line at the top of `lib/pricing.test.ts` to include the new exports:

```ts
import { calculateSellPrice, calculateBuyPrice, usdToGbp, eurToGbp, formatGBP, parsePounds, computeSaleTotals, computeMarginVat, VAT_RATE, MARGIN_VAT_DIVISOR } from './pricing'
```

(`computeMarginVat` is imported now so Task 2's tests need no re-edit of the import; it is unused until Task 2 — that is fine.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `computeMarginVat`/`VAT_RATE`/`MARGIN_VAT_DIVISOR` not exported; margin case assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `lib/pricing.ts`, replace the current `computeSaleTotals` (lines 60-73) with:

```ts
// Standard UK VAT rate. Single source of truth so a rate change is one edit.
export const VAT_RATE = 0.2
// Margin VAT is VAT-inclusive: the VAT inside a gross amount is amount × rate/(1+rate).
// For 20% that is amount/6, so divide the margin by this to get the inclusive VAT.
export const MARGIN_VAT_DIVISOR = (1 + VAT_RATE) / VAT_RATE // = 6

// Single source of truth for the CUSTOMER total — used by createSale (canonical)
// and the checkout UI (so the client's expectedTotal always agrees with the
// server). The client never needs cost data: under the margin scheme VAT is
// inclusive, so the total is identical to 'none'. Standard VAT is added on top.
// Discount is clamped to [0, subtotal].
export function computeSaleTotals(
  subtotalPence: number,
  discountPence: number,
  vatScheme: 'none' | 'standard' | 'margin',
): { discount: number; vatAmount: number; total: number } {
  const discount = Math.min(Math.max(0, discountPence), subtotalPence)
  const afterDiscount = subtotalPence - discount
  const vatAmount = vatScheme === 'standard' ? Math.round(afterDiscount * VAT_RATE) : 0
  return { discount, vatAmount, total: afterDiscount + vatAmount }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: the two new tests PASS; all existing `computeSaleTotals` / none / standard tests still PASS. (`computeMarginVat` import is present but its own tests arrive in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.ts lib/pricing.test.ts
git commit -m "feat: centralise VAT rate + add margin case to computeSaleTotals"
```

---

### Task 2: `computeMarginVat` — server-only per-line margin VAT

**Files:**
- Modify: `lib/pricing.ts` (append new function)
- Test: `lib/pricing.test.ts`

**Interfaces:**
- Consumes: `MARGIN_VAT_DIVISOR` from Task 1.
- Produces:
  - `computeMarginVat(lines: { unitPrice: number; quantity: number; costAtSale: number | null }[], discountPence: number): { vatAmount: number; noCostLineCount: number }`

- [ ] **Step 1: Write the failing test**

Add to `lib/pricing.test.ts`:

```ts
test('computeMarginVat: single line, VAT is round(margin / 6)', () => {
  // sell 1000, cost 400 → margin 600 → round(600/6) = 100
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 1000, quantity: 1, costAtSale: 400 }], 0),
    { vatAmount: 100, noCostLineCount: 0 },
  )
})

test('computeMarginVat: quantity multiplies the line, margin floored at 0 per line', () => {
  // 2 × sell 500 = 1000, cost 2 × 300 = 600 → margin 400 → round(400/6) = 67
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 500, quantity: 2, costAtSale: 300 }], 0),
    { vatAmount: 67, noCostLineCount: 0 },
  )
  // sold at a loss → margin max(0, 500-800) = 0 → no VAT
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 500, quantity: 1, costAtSale: 800 }], 0),
    { vatAmount: 0, noCostLineCount: 0 },
  )
})

test('computeMarginVat: no-cost line contributes 0 and is counted', () => {
  assert.deepEqual(
    computeMarginVat([
      { unitPrice: 1000, quantity: 1, costAtSale: 400 }, // margin 600 → 100
      { unitPrice: 900, quantity: 1, costAtSale: null },  // excluded, counted
    ], 0),
    { vatAmount: 100, noCostLineCount: 1 },
  )
})

test('computeMarginVat: discount is spread across lines by value, reducing the margin', () => {
  // Lines value 1000 and 500 (subtotal 1500), discount 300 →
  // alloc 200 and 100 → effective 800 and 400.
  // costs 400 and 200 → margins 400 and 200 → round(400/6)=67, round(200/6)=33 → 100
  assert.deepEqual(
    computeMarginVat([
      { unitPrice: 1000, quantity: 1, costAtSale: 400 },
      { unitPrice: 500, quantity: 1, costAtSale: 200 },
    ], 300),
    { vatAmount: 100, noCostLineCount: 0 },
  )
})

test('computeMarginVat: discount allocation sums exactly (largest-remainder)', () => {
  // Three equal lines value 100 each (subtotal 300), discount 100.
  // Allocations must sum to 100 exactly. costs 0 → margins are (100 - alloc_i).
  // Total effective margin = 300 - 100 = 200 spread as 66/67/67 across lines,
  // each VAT = round(m/6). Assert the total is stable regardless of tie-order.
  const { vatAmount, noCostLineCount } = computeMarginVat([
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
    { unitPrice: 100, quantity: 1, costAtSale: 0 },
  ], 100)
  // effective margins 66,67,67 → round(66/6)=11, round(67/6)=11, round(67/6)=11 → 33
  assert.equal(vatAmount, 33)
  assert.equal(noCostLineCount, 0)
})

test('computeMarginVat: discount clamped to [0, subtotal]', () => {
  // Over-large discount wipes the margin to 0.
  assert.deepEqual(
    computeMarginVat([{ unitPrice: 1000, quantity: 1, costAtSale: 400 }], 99999),
    { vatAmount: 0, noCostLineCount: 0 },
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `computeMarginVat is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/pricing.ts`:

```ts
// Server-ONLY. Computes the VAT owed to HMRC on the margin of each sale line,
// for the VAT Margin Scheme (second-hand goods). VAT is inclusive, so this does
// NOT change the customer total (see computeSaleTotals). Must never be imported
// by a client component — it takes cost data, which stays out of the browser.
//
// - Discount is spread across lines in proportion to line value (largest-remainder
//   so integer pence allocations sum exactly to the discount).
// - Per line: margin = max(0, effectiveLineValue - cost×qty); VAT = round(margin/6).
//   Margins float at 0 per line — a loss on one card cannot offset another
//   (pooling is only allowed under HMRC's Global Accounting Scheme, not implemented).
// - Lines with no cost basis (costAtSale null) can't be in the scheme: they
//   contribute 0 VAT and are counted so the caller can warn/block.
export function computeMarginVat(
  lines: { unitPrice: number; quantity: number; costAtSale: number | null }[],
  discountPence: number,
): { vatAmount: number; noCostLineCount: number } {
  const values = lines.map(l => l.unitPrice * l.quantity)
  const subtotal = values.reduce((s, v) => s + v, 0)
  const discount = Math.min(Math.max(0, discountPence), subtotal)

  // Proportional allocation with largest-remainder distribution of leftover pence.
  const alloc = values.map(v => (subtotal > 0 ? Math.floor((discount * v) / subtotal) : 0))
  let remainder = discount - alloc.reduce((s, a) => s + a, 0)
  const byFraction = values
    .map((v, i) => ({ i, frac: subtotal > 0 ? (discount * v) % subtotal : 0 }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < byFraction.length && remainder > 0; k++) {
    alloc[byFraction[k].i]++
    remainder--
  }

  let vatAmount = 0
  let noCostLineCount = 0
  lines.forEach((l, i) => {
    if (l.costAtSale == null) { noCostLineCount++; return }
    const effLineValue = values[i] - alloc[i]
    const margin = Math.max(0, effLineValue - l.costAtSale * l.quantity)
    vatAmount += Math.round(margin / MARGIN_VAT_DIVISOR)
  })
  return { vatAmount, noCostLineCount }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all Task 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.ts lib/pricing.test.ts
git commit -m "feat: add computeMarginVat (per-line margin VAT, discount allocation)"
```

---

### Task 3: Settings — schema column, types, defaults, validation + migration

**Files:**
- Modify: `lib/db/schema.ts:110-122` (settings table) and `:77` (comment)
- Modify: `lib/settings.ts:6-45` (types, defaults, mapping)
- Modify: `app/api/settings/route.ts:36-41`
- Create: `lib/db/migrations/0013_*.sql` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AppSettings.vatScheme: 'none' | 'standard' | 'margin'`
  - `AppSettings.marginNoCostHandling: 'exclude' | 'block'`
  - `settings.marginNoCostHandling` column (`margin_no_cost_handling text not null default 'exclude'`)

- [ ] **Step 1: Update the schema**

In `lib/db/schema.ts`, in the `settings` table (around line 120), change the `vatScheme` line and add the new column:

```ts
  vatScheme: text('vat_scheme').notNull().default('none'), // 'none' | 'standard' | 'margin'
  marginNoCostHandling: text('margin_no_cost_handling').notNull().default('exclude'), // 'exclude' | 'block'
```

(The `sales.vat_scheme` comment on line 77 already lists `'standard' | 'margin' | 'none'` — leave it.)

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new file `lib/db/migrations/0013_*.sql` is created containing `ALTER TABLE settings ADD margin_no_cost_handling ...` (SQLite adds the column with the default). Open it and confirm it only adds the one column.

- [ ] **Step 3: Update `lib/settings.ts` types, defaults, and mapping**

In `lib/settings.ts`:

Change the `AppSettings` interface `vatScheme` line and add the new field:

```ts
  vatScheme: 'none' | 'standard' | 'margin'
  marginNoCostHandling: 'exclude' | 'block'
```

Add to `DEFAULT_SETTINGS` (after `vatScheme: 'none',`):

```ts
  marginNoCostHandling: 'exclude',
```

In `toAppSettings`, change the `vatScheme` mapping and add the new field:

```ts
    vatScheme: row.vatScheme as 'none' | 'standard' | 'margin',
    marginNoCostHandling: row.marginNoCostHandling as 'exclude' | 'block',
```

- [ ] **Step 4: Update the settings PATCH validation**

In `app/api/settings/route.ts`, replace the `vatScheme` block (lines 36-41) with:

```ts
  if (body.vatScheme != null) {
    if (body.vatScheme !== 'none' && body.vatScheme !== 'standard' && body.vatScheme !== 'margin') {
      return NextResponse.json({ error: 'Invalid vatScheme' }, { status: 400 })
    }
    patch.vatScheme = body.vatScheme
  }
  if (body.marginNoCostHandling != null) {
    if (body.marginNoCostHandling !== 'exclude' && body.marginNoCostHandling !== 'block') {
      return NextResponse.json({ error: 'Invalid marginNoCostHandling' }, { status: 400 })
    }
    patch.marginNoCostHandling = body.marginNoCostHandling
  }
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors — the unions and mapping line up).

Run: `npm test`
Expected: existing tests still PASS (the in-memory DB rebuilds from `schema.ts`, so the new column is present).

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/ lib/settings.ts app/api/settings/route.ts
git commit -m "feat: add margin scheme + marginNoCostHandling to settings (migration 0013)"
```

---

### Task 4: `createSale` — store margin VAT, block/exclude, return no-cost count

**Files:**
- Modify: `lib/domain/sales.ts:20-23` (return type), `:66-70` (compute), `:106-115` (insert), `:150` (return)
- Test: `lib/domain/sales.test.ts`

**Interfaces:**
- Consumes: `computeSaleTotals`, `computeMarginVat` (Tasks 1-2); `AppSettings.marginNoCostHandling` (Task 3); existing `lines` array with `unitPrice`, `costAtSale`.
- Produces: `createSale(...)` now returns `{ saleId: number; total: number; marginNoCostCount: number }`. New `DomainError` code `'MARGIN_NO_COST'`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/domain/sales.test.ts` (the `base` sale is 2 × £8.50 = 1700, cost 300/unit):

```ts
test('VAT scheme "margin": total unchanged, vat_amount is the per-line margin VAT', async () => {
  await dbc.update(schema.settings).set({ vatScheme: 'margin' }).where(eq(schema.settings.id, 1))
  // 2 × (sell 850 - cost 300) = margin 1100 → round(1100/6) = 183. Total stays 1700.
  const { saleId, total, marginNoCostCount } = await createSale({ ...base, expectedTotal: 1700 }, dbc)
  assert.equal(total, 1700)
  assert.equal(marginNoCostCount, 0)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.vatScheme, 'margin')
  assert.equal(sale.subtotal, 1700)
  assert.equal(sale.total, 1700)
  assert.equal(sale.vatAmount, 183)
})

test('VAT scheme "margin": no-cost line excluded by default, counted in the result', async () => {
  await dbc.update(schema.settings).set({ vatScheme: 'margin' }).where(eq(schema.settings.id, 1))
  await dbc.update(schema.inventoryItems).set({ costPrice: null }).where(eq(schema.inventoryItems.id, 1))
  const { total, marginNoCostCount } = await createSale({ ...base, expectedTotal: 1700 }, dbc)
  assert.equal(total, 1700)
  assert.equal(marginNoCostCount, 1)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, 1))
  assert.equal(sale.vatAmount, 0) // no cost basis → no margin VAT
})

test('VAT scheme "margin" with block: no-cost line rejects the sale, nothing written', async () => {
  await dbc.update(schema.settings)
    .set({ vatScheme: 'margin', marginNoCostHandling: 'block' })
    .where(eq(schema.settings.id, 1))
  await dbc.update(schema.inventoryItems).set({ costPrice: null }).where(eq(schema.inventoryItems.id, 1))
  await assert.rejects(
    createSale({ ...base, expectedTotal: 1700 }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'MARGIN_NO_COST',
  )
  assert.equal(await stockOf(1), 5) // untouched
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})
```

Also update the existing happy-path assertion that reads the createSale result if needed — the return now has an extra field but destructuring `{ saleId, total }` still works, so no change required there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `marginNoCostCount` is `undefined`; `vat_amount` is 0 for margin (not yet computed); block does not throw.

- [ ] **Step 3: Implement**

In `lib/domain/sales.ts`:

Change the return type (line 22-23):

```ts
): Promise<{ saleId: number; total: number; marginNoCostCount: number }> {
```

Replace the totals computation (lines 69-70) with:

```ts
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
  const { discount, vatAmount: standardVat, total } = computeSaleTotals(subtotal, input.discount ?? 0, settings.vatScheme)

  // Margin scheme: VAT is inclusive (total already correct above); compute the
  // per-line margin VAT owed to HMRC from the cost snapshots, server-side only.
  let vatAmount = standardVat
  let marginNoCostCount = 0
  if (settings.vatScheme === 'margin') {
    const margin = computeMarginVat(lines, discount)
    vatAmount = margin.vatAmount
    marginNoCostCount = margin.noCostLineCount
    if (settings.marginNoCostHandling === 'block' && marginNoCostCount > 0) {
      throw new DomainError('MARGIN_NO_COST', 'Sale contains item(s) with no cost basis — cannot use the VAT Margin Scheme. Enter a cost or change the no-cost setting.', { marginNoCostCount })
    }
  }
```

Update the import on line 4 to include `computeMarginVat`:

```ts
import { calculateSellPrice, pickMarketPrice, computeSaleTotals, computeMarginVat } from '@/lib/pricing'
```

The `sales` insert (lines 106-115) already uses `vatAmount` and `settings.vatScheme` — no change needed; it now carries the margin figure.

Change the final return (line 150) to:

```ts
  return { saleId, total, marginNoCostCount }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: the three new margin tests PASS; all existing sales tests (none/standard/store-credit/idempotency) still PASS.

- [ ] **Step 5: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS. (The `/api/sales` POST route returns `result` directly, so `marginNoCostCount` flows to the client with no route change.)

- [ ] **Step 6: Commit**

```bash
git add lib/domain/sales.ts lib/domain/sales.test.ts
git commit -m "feat: compute+store margin VAT in createSale; block/exclude no-cost lines"
```

---

### Task 5: Stock-book export — domain query + admin CSV route

**Files:**
- Modify: `lib/domain/reports.ts` (append query + imports)
- Test: `lib/domain/reports.test.ts`
- Create: `app/api/reports/margin-stock-book/route.ts`

**Interfaces:**
- Consumes: `computeMarginVat`-consistent per-line math (inline in SQL/JS); `sales`, `saleItems`, `inventoryItems`, `cards` tables.
- Produces:
  - `getMarginStockBook(from: string, to: string, dbc?: Db): Promise<MarginStockBookRow[]>`
  - `interface MarginStockBookRow { saleId: number; soldAt: string; cardName: string | null; condition: string; quantity: number; costPence: number | null; salePence: number; marginPence: number; vatPence: number; noCostBasis: boolean }`
  - `GET /api/reports/margin-stock-book?from=YYYY-MM-DD&to=YYYY-MM-DD` → `text/csv` (admin only)

- [ ] **Step 1: Write the failing test**

Add to `lib/domain/reports.test.ts` (follow the file's existing seeding style — check its top for `createTestDb`/`seedBase` helpers and reuse them). Insert a margin sale then assert the rows:

```ts
test('getMarginStockBook: one row per margin sale-line with margin + VAT', async () => {
  // A margin-scheme sale: sell 1000, cost 400, qty 1 → margin 600 → VAT round(600/6)=100
  await dbc.insert(schema.cards).values({ id: 1, name: 'Charizard', setName: 'Base', number: '4' })
  await dbc.insert(schema.inventoryItems).values({ id: 1, cardId: 1, condition: 'NM', quantity: 0, costPrice: 400, qrCode: 'qr-sb-1' })
  const [sale] = await dbc.insert(schema.sales).values({
    subtotal: 1000, discountAmount: 0, vatAmount: 100, vatScheme: 'margin', total: 1000, paymentMethod: 'cash',
    createdAt: '2026-07-11 10:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({
    saleId: sale.id, inventoryItemId: 1, quantity: 1, priceAtSale: 1000, costAtSale: 400,
  })

  const rows = await getMarginStockBook('2026-07-11', '2026-07-11', dbc)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cardName, 'Charizard')
  assert.equal(rows[0].salePence, 1000)
  assert.equal(rows[0].costPence, 400)
  assert.equal(rows[0].marginPence, 600)
  assert.equal(rows[0].vatPence, 100)
  assert.equal(rows[0].noCostBasis, false)
})

test('getMarginStockBook: only includes margin-scheme sales, flags no-cost lines', async () => {
  await dbc.insert(schema.cards).values({ id: 1, name: 'Pikachu', setName: 'Base', number: '58' })
  await dbc.insert(schema.inventoryItems).values({ id: 1, cardId: 1, condition: 'NM', quantity: 0, costPrice: null, qrCode: 'qr-sb-2' })
  // standard-scheme sale — must be excluded
  const [std] = await dbc.insert(schema.sales).values({
    subtotal: 500, discountAmount: 0, vatAmount: 100, vatScheme: 'standard', total: 600, paymentMethod: 'cash',
    createdAt: '2026-07-11 11:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: std.id, inventoryItemId: 1, quantity: 1, priceAtSale: 500, costAtSale: 200 })
  // margin sale with a no-cost line
  const [mrg] = await dbc.insert(schema.sales).values({
    subtotal: 900, discountAmount: 0, vatAmount: 0, vatScheme: 'margin', total: 900, paymentMethod: 'cash',
    createdAt: '2026-07-11 12:00:00',
  }).returning()
  await dbc.insert(schema.saleItems).values({ saleId: mrg.id, inventoryItemId: 1, quantity: 1, priceAtSale: 900, costAtSale: null })

  const rows = await getMarginStockBook('2026-07-11', '2026-07-11', dbc)
  assert.equal(rows.length, 1) // only the margin sale
  assert.equal(rows[0].noCostBasis, true)
  assert.equal(rows[0].costPence, null)
  assert.equal(rows[0].marginPence, 0)
  assert.equal(rows[0].vatPence, 0)
})
```

Ensure the test file imports `getMarginStockBook` and `schema`. If the file lacks `createTestDb`/`seedBase` in scope, mirror the imports already at the top of `lib/domain/sales.test.ts`:

```ts
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getMarginStockBook } from './reports'
```

and a `beforeEach` that does `dbc = await createTestDb(); await seedBase(dbc)`.

> Before writing, open `lib/domain/reports.test.ts` and the `cards` / `inventory_items` schema to confirm the exact required (non-null) columns for the inserts above (e.g. whether `cards.setName`/`number` are required). Adjust the seed inserts to satisfy them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `getMarginStockBook is not a function`.

- [ ] **Step 3: Implement the domain query**

In `lib/domain/reports.ts`, add `saleItems`, `inventoryItems`, `cards` to the schema import on line 11:

```ts
import { sales, refunds, buyTransactions, staff, saleItems, inventoryItems, cards } from '@/lib/db/schema'
```

Append to the file. Margin/VAT are computed in JS per row (clearer than SQL and identical to `computeMarginVat`'s per-line rule):

```ts
// ---------------------------------------------------------------------------
// getMarginStockBook
// ---------------------------------------------------------------------------
// The VAT Margin Scheme legally requires a "stock book": a purchase→sale record
// per item. One row per line of every margin-scheme sale in the range. Money is
// integer pence; margin/VAT mirror computeMarginVat (per-line, round(margin/6)).
// Lines with no cost basis are flagged and carry 0 margin/VAT (they can't be in
// the scheme). Ordered oldest-first for a readable ledger.

export interface MarginStockBookRow {
  saleId: number
  soldAt: string
  cardName: string | null
  condition: string
  quantity: number
  costPence: number | null // per-unit cost snapshot
  salePence: number // per-unit sale price
  marginPence: number // line margin: max(0, (sale-cost)×qty)
  vatPence: number // round(margin / 6)
  noCostBasis: boolean
}

export async function getMarginStockBook(from: string, to: string, dbc: Db = db): Promise<MarginStockBookRow[]> {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`

  const rows = await dbc
    .select({
      saleId: sales.id,
      soldAt: sales.createdAt,
      cardName: cards.name,
      condition: inventoryItems.condition,
      quantity: saleItems.quantity,
      salePence: saleItems.priceAtSale,
      costPence: saleItems.costAtSale,
    })
    .from(saleItems)
    .innerJoin(sales, eq(saleItems.saleId, sales.id))
    .leftJoin(inventoryItems, eq(saleItems.inventoryItemId, inventoryItems.id))
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .where(and(
      eq(sales.vatScheme, 'margin'),
      gte(sales.createdAt, fromTs),
      lt(sales.createdAt, toExcl),
    ))
    .orderBy(sales.createdAt)

  return rows.map(r => {
    const noCostBasis = r.costPence == null
    const marginPence = noCostBasis ? 0 : Math.max(0, (r.salePence - (r.costPence as number)) * r.quantity)
    return {
      saleId: r.saleId,
      soldAt: r.soldAt,
      cardName: r.cardName ?? null,
      condition: r.condition ?? '',
      quantity: r.quantity,
      costPence: r.costPence ?? null,
      salePence: r.salePence,
      marginPence,
      vatPence: Math.round(marginPence / 6),
      noCostBasis,
    }
  })
}
```

> Note: this per-row export does NOT re-apply the whole-sale discount allocation (the export lists gross line margins for the stock book); the authoritative per-sale VAT owed is the stored `sales.vat_amount`. That is an accepted, documented simplification for the record — the sales report's `vatTotal` remains the figure of record. Keep the `6` here consistent with `MARGIN_VAT_DIVISOR`; if you prefer, import it: `import { MARGIN_VAT_DIVISOR } from '@/lib/pricing'` and divide by it.

Delete the scaffold version entirely — only the concrete implementation remains.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: both `getMarginStockBook` tests PASS.

- [ ] **Step 5: Create the CSV route**

Create `app/api/reports/margin-stock-book/route.ts`:

```ts
// app/api/reports/margin-stock-book/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getMarginStockBook } from '@/lib/domain/reports'
import { toCSV } from '@/lib/csv'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const gbp = (p: number | null) => (p == null ? '' : (p / 100).toFixed(2))

export const GET = guarded(async (req: NextRequest) => {
  requireAdmin(await getSession())

  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be before to' }, { status: 400 })
  }

  const rows = await getMarginStockBook(from, to)
  const csv = toCSV(
    ['Sale #', 'Sold at', 'Card', 'Condition', 'Qty', 'Cost (£)', 'Sale (£)', 'Margin (£)', 'VAT (£)', 'No cost basis'],
    rows.map(r => [
      r.saleId, r.soldAt, r.cardName ?? 'Unknown', r.condition, r.quantity,
      gbp(r.costPence), gbp(r.salePence), gbp(r.marginPence), gbp(r.vatPence),
      r.noCostBasis ? 'YES' : '',
    ]),
  )

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="margin-stock-book-${from}_to_${to}.csv"`,
    },
  })
})
```

> Confirm `toCSV`'s signature in `lib/csv.ts` (`toCSV(headers: string[], rows: (string|number|null|undefined)[][]): string`) — it matches the call above and already escapes formula-injection.

- [ ] **Step 6: Verify build + gate**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/reports.ts lib/domain/reports.test.ts app/api/reports/margin-stock-book/route.ts
git commit -m "feat: margin-scheme stock-book CSV export (domain query + admin route)"
```

---

### Task 6: Settings UI — 3-way VAT toggle + no-cost handling control

**Files:**
- Modify: `components/settings/SettingsForm.tsx:22-23`, `:44-54`, `:138-167`

**Interfaces:**
- Consumes: `AppSettings.vatScheme` (3-way) and `marginNoCostHandling` from Task 3.
- Produces: sends both fields in the PATCH body.

- [ ] **Step 1: Widen the state**

In `components/settings/SettingsForm.tsx`, change the VAT state (line 23) and add the no-cost state:

```ts
  const [vatScheme, setVatScheme] = useState<'none' | 'standard' | 'margin'>(current.vatScheme)
  const [marginNoCostHandling, setMarginNoCostHandling] = useState<'exclude' | 'block'>(current.marginNoCostHandling)
```

- [ ] **Step 2: Send both fields**

In the `save()` PATCH body (around lines 52-53), add `marginNoCostHandling` next to `vatScheme`:

```ts
          primaryPriceSource,
          vatScheme,
          marginNoCostHandling,
```

- [ ] **Step 3: Replace the 2-way toggle with a 3-way toggle + conditional no-cost control**

Replace the entire VAT scheme block (lines 138-167 — the `<div className="space-y-1.5">` containing the `Not registered` / `Standard VAT` buttons) with:

```tsx
        <div className="space-y-1.5">
          <Label>VAT scheme</Label>
          <div className="flex gap-2">
            {([
              ['none', 'Not registered'],
              ['standard', 'Standard VAT'],
              ['margin', 'Margin scheme'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setVatScheme(value)}
                className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                  vatScheme === value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Applied to sales at checkout. <strong>Margin scheme</strong>: VAT is charged only on your
            profit (sale − cost) per card and is already included in the shelf price — the customer pays
            the same and no VAT line shows on their receipt.
          </p>
        </div>

        {vatScheme === 'margin' && (
          <div className="space-y-1.5">
            <Label>Cards with no recorded cost</Label>
            <div className="flex gap-2">
              {([
                ['exclude', 'Sell & warn'],
                ['block', 'Block sale'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMarginNoCostHandling(value)}
                  className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    marginNoCostHandling === value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A card with no recorded purchase price can&apos;t legally use the margin scheme.
              <strong> Sell &amp; warn</strong>: complete the sale, charge £0 margin VAT on that card,
              and flag it (review it in the margin stock book). <strong>Block sale</strong>: refuse the
              sale until a cost is entered.
            </p>
            <div className="bg-muted/30 rounded-lg p-3 text-sm">
              <div className="text-xs text-muted-foreground mb-1">Worked example — a card you sell for £10 that cost you £4:</div>
              <div className="flex justify-between"><span className="text-muted-foreground">Profit (margin)</span><span className="font-medium">{formatGBP(600)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">VAT owed (included in the £10)</span><span className="font-bold text-primary">{formatGBP(Math.round(600 / 6))}</span></div>
            </div>
          </div>
        )}
```

- [ ] **Step 4: Verify build + types + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/settings/SettingsForm.tsx
git commit -m "feat: settings UI — 3-way VAT toggle + margin no-cost handling"
```

---

### Task 7: Receipt + checkout + POS surfaces

**Files:**
- Modify: `components/pos/ReceiptDialog.tsx:8-20`, `:44-53` (print), `:87-95` (dialog)
- Modify: `components/pos/CheckoutDialog.tsx:174-184`
- Modify: `app/(app)/pos/page.tsx:184-205`

**Interfaces:**
- Consumes: `ReceiptData` gains `vatScheme`; `createSale` result's `marginNoCostCount` (Task 4).
- Produces: margin receipts show no VAT figure + a scheme note; the till warns on no-cost lines.

- [ ] **Step 1: Add `vatScheme` to `ReceiptData` and render the margin note (screen + print)**

In `components/pos/ReceiptDialog.tsx`, add to the `ReceiptData` interface (after `vatAmount: number`):

```ts
  vatScheme: 'none' | 'standard' | 'margin'
```

In `receiptHtml`, replace the VAT row line (line 48) so the VAT figure only shows for standard, and add a margin note after the Total. Change:

```ts
${r.vatAmount > 0 ? row('VAT (20%)', formatGBP(r.vatAmount)) : ''}
```

to:

```ts
${r.vatScheme === 'standard' && r.vatAmount > 0 ? row('VAT (20%)', formatGBP(r.vatAmount)) : ''}
```

Then, immediately after the closing `</table>` that follows the totals (line 53) and before `<hr/>`, insert the margin note:

```ts
${r.vatScheme === 'margin' ? '<p style="margin:6px 0 0;font-size:11px;">Sold under the VAT Margin Scheme</p>' : ''}
```

In the on-screen dialog totals (around line 90), change the VAT line condition:

```tsx
{receipt.vatScheme === 'standard' && receipt.vatAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>VAT (20%)</span><span>{formatGBP(receipt.vatAmount)}</span></div>}
```

and after the Total line (after line 91's `</div>`), add:

```tsx
{receipt.vatScheme === 'margin' && <div className="text-xs text-muted-foreground pt-1">Sold under the VAT Margin Scheme</div>}
```

- [ ] **Step 2: CheckoutDialog — hide the "VAT (20%)" line under margin**

In `components/pos/CheckoutDialog.tsx`, the `vatAmount` is already `0` under margin (from `computeSaleTotals`), so the existing `{vatAmount > 0 && ...}` block hides automatically. To make the label correct and add the margin note, replace the VAT block (lines 180-184) with:

```tsx
          {vatScheme === 'standard' && vatAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>VAT (20%)</span><span>{formatGBP(vatAmount)}</span>
            </div>
          )}
          {vatScheme === 'margin' && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>VAT Margin Scheme</span><span>included</span>
            </div>
          )}
```

- [ ] **Step 3: POS page — pass `vatScheme` to the receipt and warn on no-cost lines**

In `app/(app)/pos/page.tsx`, in `handleCheckoutConfirm`, change the success branch (lines 182-205). Read `marginNoCostCount` from the response and add `vatScheme` to the receipt:

Change line 183:

```ts
      const { saleId, total, marginNoCostCount } = await res.json()
```

Add `vatScheme` to the `ReceiptData` object (after the `vatAmount:` line, line 192):

```ts
        vatScheme,
```

After the existing success `toast.success(...)` call (after line 205), add:

```ts
      if (marginNoCostCount > 0) {
        toast.warning(`${marginNoCostCount} card(s) had no cost basis — excluded from margin VAT. Review the margin stock book.`)
      }
```

> `vatScheme` is already destructured from `useSettings()` at line 50, so it is in scope.

- [ ] **Step 4: Verify build + types + lint + tests**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: PASS. (`sonner`'s `toast.warning` exists; if lint flags it, use `toast(...)` with an icon or `toast.error` styling — but `toast.warning` is supported in the installed version; confirm via `components/pos` existing usage of `toast`.)

- [ ] **Step 5: Commit**

```bash
git add components/pos/ReceiptDialog.tsx components/pos/CheckoutDialog.tsx app/(app)/pos/page.tsx
git commit -m "feat: margin-scheme receipt note + hide VAT line + till no-cost warning"
```

---

### Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the complete gate**

Run: `npm test && npm run lint && npx tsc --noEmit && npm run build`
Expected: all PASS — every existing none/standard test still green; new margin tests green; production build succeeds.

- [ ] **Step 2: Manual smoke checklist (dev server)**

Start `npm run dev`, then in Settings (as admin): switch VAT scheme to **Margin scheme**, confirm the no-cost control + worked example appear, save. Ring up a card at POS: confirm the total is unchanged vs "none", the checkout shows "VAT Margin Scheme — included", and the printed receipt shows the "Sold under the VAT Margin Scheme" note with **no** VAT figure. Then GET `/api/reports/margin-stock-book?from=YYYY-MM-DD&to=YYYY-MM-DD` (admin) and confirm a CSV downloads with the sale line, margin, and VAT.

- [ ] **Step 3: Note the migration hand-off**

The generated migration `0013_*.sql` must be applied to the live DB by the user (deploy does not auto-migrate; unset shell `TURSO_*` before `npx drizzle-kit migrate`). Flag this in the completion summary — do not attempt to run it against the live DB.

---

## Out of scope (documented follow-up)

**Refunds on margin sales.** A refund against a margin sale reduces the margin VAT owed, and a fully correct stock book should net refunded items. This plan ships the sale path only; `lib/domain/refunds.ts` is untouched and the stock book reflects **gross** margin sales. This is a known, documented limitation (see spec §10) to be raised as its own backlog item.
