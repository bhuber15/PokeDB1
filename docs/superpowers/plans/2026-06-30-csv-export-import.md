# CSV Export & Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download sales and inventory as CSV files, and bulk-add/update inventory by uploading a CSV from the UI.

**Architecture:** A tiny dependency-free `lib/csv.ts` (RFC-4180-style `toCSV`/`parseCSV`). Export endpoints stream `text/csv` with a `Content-Disposition: attachment` header; the UI links/buttons just hit those URLs. The import endpoint parses an uploaded CSV, validates each row, and upserts inventory — matching cards by `externalId` (preferred) or `name`+`set_number`, creating the card if needed, then creating a new inventory item per row. It returns a per-row summary so the user sees exactly what happened.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle, shadcn/ui + Tailwind v4, sonner.

## Global Constraints

- Node 24 LTS; Next.js 16 App Router only; TypeScript strict; no new npm dependencies (CSV is hand-rolled).
- Money is SQLite `real`, GBP, 2dp. Conditions: `NM | LP | MP | HP | DMG`.
- Auth: sales export is **admin/owner only**; inventory export needs `session.staffId`; inventory import needs `session.isOwnerLoggedIn` (it creates stock — same guard as `POST /api/inventory`).
- CSV must round-trip safely: fields containing `,` `"` or newlines are double-quoted with `"` escaped as `""`.
- **Verification:** no unit-test runner; verify via `npx tsc --noEmit` (clean) plus the concrete `npx tsx scripts/<name>.ts` or `curl` check named in each task.
- Reuse: `db`, `getSession`, `formatGBP` (display only — CSV stores raw numbers), schema tables, `generateQRId` from `lib/qr`.

---

## File Structure

- `lib/csv.ts` — `toCSV(headers, rows)` and `parseCSV(text)`. Pure, no I/O.
- `app/api/reports/sales/export/route.ts` — `GET` → sales CSV (admin).
- `app/api/inventory/export/route.ts` — `GET` → inventory CSV (staff).
- `app/api/inventory/import/route.ts` — `POST` (CSV body) → upsert summary (owner).
- `components/inventory/ImportDialog.tsx` — upload UI + summary + template download.
- `app/(app)/reports/page.tsx` — "Export CSV" button.
- `app/(app)/inventory/page.tsx` — "Export CSV" + "Import CSV" buttons.

---

## Task 1: CSV library

**Files:**
- Create: `lib/csv.ts`
- Create (throwaway): `scripts/_verify-csv.ts`

**Interfaces:**
- Produces: `toCSV(headers: string[], rows: (string | number | null | undefined)[][]): string`; `parseCSV(text: string): string[][]` (first row = header row; returns all rows including header).

- [ ] **Step 1:** Write `lib/csv.ts`:

```ts
function escapeField(v: string | number | null | undefined): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeField).join(',')]
  for (const row of rows) lines.push(row.map(escapeField).join(','))
  return lines.join('\r\n')
}

// Minimal RFC-4180 parser: handles quoted fields, escaped quotes, embedded commas/newlines.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''))
}
```

- [ ] **Step 2:** `scripts/_verify-csv.ts` — round-trip + tricky fields:

```ts
import { toCSV, parseCSV } from '../lib/csv'
const csv = toCSV(['name', 'note', 'qty'], [
  ['Charizard', 'Holo, NM', 2],
  ['Pikachu "Red Cheeks"', 'line1\nline2', 1],
])
console.log(csv)
const parsed = parseCSV(csv)
console.log('rows (expect 3):', parsed.length)
console.log('note with comma (expect "Holo, NM"):', parsed[1][1])
console.log('quoted name (expect Pikachu "Red Cheeks"):', parsed[2][0])
console.log('embedded newline (expect line1\\nline2):', JSON.stringify(parsed[2][1]))
if (parsed.length !== 3 || parsed[1][1] !== 'Holo, NM') throw new Error('round-trip failed')
```

Run: `npx tsx scripts/_verify-csv.ts`
Expected: 3 rows; comma field intact; quoted name intact; embedded newline preserved. Then `rm scripts/_verify-csv.ts`.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add lib/csv.ts
git commit -m "feat: dependency-free CSV encode/parse"
```

---

## Task 2: Sales CSV export

**Files:**
- Create: `app/api/reports/sales/export/route.ts`
- Modify: `app/(app)/reports/page.tsx`

**Interfaces:**
- Produces: `GET /api/reports/sales/export` → `text/csv` attachment `sales-YYYY-MM-DD.csv`, columns `sale_id, datetime, staff, payment_method, subtotal, discount, vat, total`. Admin/owner only.

- [ ] **Step 1:** Write the route:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, staff } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { toCSV } from '@/lib/csv'

export async function GET() {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const rows = await db.select({ sale: sales, staffName: staff.name })
    .from(sales).leftJoin(staff, eq(sales.staffId, staff.id))
    .orderBy(desc(sales.createdAt))
  const csv = toCSV(
    ['sale_id', 'datetime', 'staff', 'payment_method', 'subtotal', 'discount', 'vat', 'total'],
    rows.map(({ sale, staffName }) => [
      sale.id, sale.createdAt, staffName ?? '', sale.paymentMethod,
      sale.subtotal, sale.discountAmount, sale.vatAmount, sale.total,
    ]),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sales-${date}.csv"`,
    },
  })
}
```

- [ ] **Step 2:** In `app/(app)/reports/page.tsx`, add a download button in the header next to `<h1>`: `<a href="/api/reports/sales/export"><Button variant="outline">Export CSV</Button></a>` (import `Button`).

- [ ] **Step 3: Verify:** with dev server + admin session, `curl -s -b '<cookie>' localhost:3000/api/reports/sales/export` returns CSV text with the header row and one row per sale; the `Content-Disposition` header names `sales-<date>.csv`. In the browser, the button downloads the file.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/reports/sales/export app/(app)/reports/page.tsx
git commit -m "feat: export sales to CSV"
```

---

## Task 3: Inventory CSV export

**Files:**
- Create: `app/api/inventory/export/route.ts`
- Modify: `app/(app)/inventory/page.tsx`

**Interfaces:**
- Produces: `GET /api/inventory/export` → `text/csv` attachment `inventory-YYYY-MM-DD.csv`, columns `inventory_id, external_id, name, set_name, set_number, condition, quantity, cost_price, sell_price_override, location, defect_notes`. Active items only. `session.staffId` required. **These columns are import-compatible** (Task 4 reads the same names).

- [ ] **Step 1:** Write the route — join `inventoryItems` (active) to `cards`, map to rows via `toCSV`, same attachment pattern as Task 2 but with `session.staffId` guard.

- [ ] **Step 2:** In `app/(app)/inventory/page.tsx` header, add `<a href="/api/inventory/export"><Button variant="outline">Export CSV</Button></a>` beside the existing "+ Add Item" link.

- [ ] **Step 3: Verify:** `curl -s -b '<cookie>' localhost:3000/api/inventory/export` returns CSV with the documented header and one row per active item; browser button downloads `inventory-<date>.csv`.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/inventory/export app/(app)/inventory/page.tsx
git commit -m "feat: export inventory to CSV (import-compatible columns)"
```

---

## Task 4: Inventory CSV import

**Files:**
- Create: `app/api/inventory/import/route.ts`

**Interfaces:**
- Produces: `POST /api/inventory/import` (raw CSV in the request body, `Content-Type: text/csv`) → `{ created: number, errors: { row: number, message: string }[] }`. `session.isOwnerLoggedIn` required.
- Row contract (header names, order-independent): required `condition`, `quantity`, `cost_price`, and a card identity — either `external_id` OR (`name` + `set_number`). Optional: `name`, `set_name`, `set_number`, `sell_price_override`, `location`, `defect_notes`. Card matching: by `external_id` first; else by `name`+`set_number`; if no match and `name`+`set_number` present, create a minimal `cards` row; otherwise the row errors. Each valid row inserts one `inventory_items` row (with a fresh `qrCode`) and a `price_cache` row if the card is newly created (prices null — backfilled later).

- [ ] **Step 1:** Write the route:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, inventoryItems, priceCache } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { parseCSV } from '@/lib/csv'
import { generateQRId } from '@/lib/qr'

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.isOwnerLoggedIn) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const text = await req.text()
  const rows = parseCSV(text)
  if (rows.length < 2) return NextResponse.json({ error: 'Empty or header-only CSV' }, { status: 400 })

  const header = rows[0].map(h => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const col = (r: string[], name: string) => { const i = idx(name); return i >= 0 ? r[i]?.trim() : '' }

  const errors: { row: number; message: string }[] = []
  let created = 0

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNo = i + 1
    try {
      const condition = col(r, 'condition')?.toUpperCase()
      const quantity = parseInt(col(r, 'quantity'))
      const costPrice = parseFloat(col(r, 'cost_price'))
      const externalId = col(r, 'external_id') || null
      const name = col(r, 'name') || null
      const setName = col(r, 'set_name') || null
      const setNumber = col(r, 'set_number') || null

      if (!CONDITIONS.has(condition)) throw new Error(`bad condition "${condition}"`)
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('bad quantity')
      if (!(costPrice >= 0)) throw new Error('bad cost_price')

      let cardId: number | null = null
      if (externalId) {
        const [c] = await db.select().from(cards).where(eq(cards.externalId, externalId)).limit(1)
        if (c) cardId = c.id
      }
      if (!cardId && name && setNumber) {
        const [c] = await db.select().from(cards)
          .where(and(eq(cards.name, name), eq(cards.setNumber, setNumber))).limit(1)
        if (c) cardId = c.id
      }
      if (!cardId) {
        if (!name || !setNumber) throw new Error('no card match and missing name/set_number to create one')
        const [c] = await db.insert(cards).values({
          name, setName: setName ?? '', setNumber, externalId,
        }).returning()
        cardId = c.id
        await db.insert(priceCache).values({ cardId }).onConflictDoNothing()
      }

      const sellOverrideRaw = col(r, 'sell_price_override')
      await db.insert(inventoryItems).values({
        cardId, condition, quantity, costPrice: round2(costPrice),
        sellPriceOverride: sellOverrideRaw ? round2(parseFloat(sellOverrideRaw)) : null,
        qrCode: generateQRId(),
        location: col(r, 'location') || null,
        defectNotes: col(r, 'defect_notes') || null,
      })
      created++
    } catch (e) {
      errors.push({ row: rowNo, message: e instanceof Error ? e.message : 'error' })
    }
  }
  return NextResponse.json({ created, errors })
}
```

- [ ] **Step 2: Verify** with a small CSV. Create `/tmp/imp.csv`:

```
external_id,name,set_name,set_number,condition,quantity,cost_price,location
base1-4,Charizard,Base Set,4/102,NM,1,120,Case A
,Bad Row,,,XX,0,abc,
```

Run: `curl -s -b '<cookie>' -X POST localhost:3000/api/inventory/import -H 'content-type: text/csv' --data-binary @/tmp/imp.csv`
Expected: `{"created":1,"errors":[{"row":3,"message":"bad condition \"XX\""}]}` (the good row imports, the bad row reports its problem). Confirm the new stock shows in Inventory.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/inventory/import
git commit -m "feat: bulk inventory import from CSV with per-row validation"
```

---

## Task 5: Import UI

**Files:**
- Create: `components/inventory/ImportDialog.tsx`
- Modify: `app/(app)/inventory/page.tsx`

**Interfaces:**
- Consumes: `POST /api/inventory/import`. Provides a file picker, posts the file text, shows `{ created, errors }`, and offers a downloadable template.

- [ ] **Step 1:** `components/inventory/ImportDialog.tsx` — `'use client'`. A shadcn `Dialog` with: a "Download template" link (an `<a download="inventory-template.csv" href={templateHref}>` where `templateHref` is a `data:text/csv` URL containing the header row `external_id,name,set_name,set_number,condition,quantity,cost_price,sell_price_override,location,defect_notes` plus one example line), a file `<input type="file" accept=".csv">`, and an "Import" button that reads the file via `await file.text()` and `POST`s it to `/api/inventory/import` with `Content-Type: text/csv`. On response: `toast.success(`Imported ${created} items`)`, and if `errors.length` render the list (row + message). Call an `onDone()` prop so the page can refetch inventory.

- [ ] **Step 2:** In `app/(app)/inventory/page.tsx`, add an "Import CSV" button beside Export that opens the dialog; on `onDone`, re-run the inventory `fetch`.

- [ ] **Step 3: Verify in browser:** open Import, download the template, fill 2 rows (one valid, one with a bad condition), upload — toast shows "Imported 1 items", the error row is listed, and the new item appears after refetch.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add components/inventory/ImportDialog.tsx app/(app)/inventory/page.tsx
git commit -m "feat: inventory CSV import UI with template + error report"
```

---

## Self-Review Notes

- **Round-trip safety:** export columns (Task 3) are exactly the import columns (Task 4), so an exported file re-imports cleanly. ✓
- **CSV escaping:** commas/quotes/newlines handled and verified in Task 1. ✓
- **Import is row-resilient:** one bad row never aborts the batch; every failure is reported with its row number. ✓
- **Auth:** sales export admin-only; inventory import owner-only (creates stock); matches existing route guards. ✓
- **No new dependencies:** CSV is hand-rolled per the constraint. ✓
- Out of scope (noted): updating existing inventory quantities by id on import (current import always creates new rows — an "update mode" keyed on `inventory_id` could be added later); streaming very large files (fine for a single shop's volumes).
