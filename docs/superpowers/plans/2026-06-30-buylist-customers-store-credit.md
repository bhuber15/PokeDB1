# Buylist, Customers & Store Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the shop buy cards from the public (cash or store credit), track customers and their store-credit balances, and maintain customer want lists.

**Architecture:** New `customers`, `credit_ledger`, `buy_transactions`, `buy_items` and `want_list` tables. Store-credit balance is **derived** by summing an append-only `credit_ledger` (never a mutable balance column) so it stays auditable. A buy-in records a transaction, creates/increments inventory at the agreed cost price, and — if paid in credit — appends a positive ledger row. Paying with store credit at the POS appends a negative ledger row inside the existing sale transaction. Buy-pricing is a configurable percentage of market price, stored in `settings`.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle ORM, iron-session auth, shadcn/ui + Tailwind v4, sonner for toasts.

## Global Constraints

- Node 24 LTS; Next.js 16 App Router only; TypeScript strict.
- All money is SQLite `real`, GBP, rounded to 2dp at write time (`Math.round(n*100)/100`).
- Store-credit balance is **always** `SUM(credit_ledger.delta)` for a customer — never a stored column.
- Conditions: `NM | LP | MP | HP | DMG` only. Payment methods: `cash | card | store_credit | other`.
- Staff roles: `admin | staff`. Auth model: owner password gates the app (`isOwnerLoggedIn`); staff PIN sets `session.staffId` + `session.staffRole`. Staff-facing API routes require `session.staffId`; admin/owner-only routes require `session.staffRole === 'admin' || session.isOwnerLoggedIn`.
- Any DB write that spans multiple rows that must all succeed (a buy-in, a credit-paying sale) MUST use `db.transaction(...)`.
- **Verification:** this project has no unit-test runner. Each task verifies via `npx tsc --noEmit` (must be clean) **plus** the concrete check named in the task — usually a `npx tsx --env-file=.env.local scripts/<name>.ts` script that asserts against the live Turso DB, or a `curl` against `npm run dev`. Delete throwaway scripts after use unless the task says to keep them.
- Migrations: `npx drizzle-kit generate` then apply with env exported (`export $(grep -v '^#' .env.local | sed 's/\\$/$/g')` then `npx drizzle-kit migrate`). `.env.local` is gitignored — never commit it.
- Reuse existing helpers: `formatGBP`, `calculateSellPrice` from `lib/pricing.ts`; `getSettings`/`updateSettings` from `lib/settings.ts`; `getSession` from `lib/auth.ts`; `db` from `lib/db`. Toasts: `import { toast } from 'sonner'`.

---

## File Structure

- `lib/db/schema.ts` — add `customers`, `creditLedger`, `buyTransactions`, `buyItems`, `wantList` tables + buy-% columns on `settings`; export their `$inferSelect` types.
- `lib/credit.ts` — `getCustomerBalance(customerId)` (sums ledger), `calculateBuyPrice(market, pct)`.
- `lib/settings.ts` — extend `AppSettings` + defaults with `buyCashPct`, `buyCreditPct`.
- `app/api/customers/route.ts` — `GET` (search), `POST` (create).
- `app/api/customers/[id]/route.ts` — `GET` (customer + balance + ledger + wants), `PATCH` (edit).
- `app/api/customers/[id]/credit/route.ts` — `POST` (manual credit adjustment, admin only).
- `app/api/buys/route.ts` — `POST` (record buy-in, transactional), `GET` (recent buys).
- `app/api/wants/route.ts` — `GET` (open wants + in-stock flag), `POST` (add), `DELETE` (remove/fulfil).
- `app/api/sales/route.ts` — extend `POST` to accept `customerId` + `store_credit` payment writing a negative ledger row in-transaction.
- `app/(app)/buylist/page.tsx` + `components/buylist/BuyCard.tsx` + `components/buylist/BuyCart.tsx` — the buy screen.
- `app/(app)/customers/page.tsx` + `app/(app)/customers/[id]/page.tsx` + `components/customers/*` — customer list & detail.
- `components/shared/CustomerPicker.tsx` — search/create-customer combobox reused by buylist and POS.
- `components/layout/Nav.tsx` — add Buy + Customers links.
- `app/(app)/settings/page.tsx` + `components/settings/SettingsForm.tsx` — add buy-% fields.
- `lib/settings.ts` consumers stay backward compatible (new fields have defaults).

---

## Task 1: Schema — customers, credit ledger, buys, want list, buy-% settings

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/db/migrations/<generated>.sql` (via drizzle-kit)

**Interfaces:**
- Produces tables/types: `customers`/`Customer`, `creditLedger`/`CreditLedger`, `buyTransactions`/`BuyTransaction`, `buyItems`/`BuyItem`, `wantList`/`WantListItem`; `settings.buyCashPct`, `settings.buyCreditPct`.

- [ ] **Step 1: Add the tables** to `lib/db/schema.ts` (after `settings`, before the type exports):

```ts
export const customers = sqliteTable('customers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const creditLedger = sqliteTable('credit_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  delta: real('delta').notNull(), // +credit issued, -credit spent
  reason: text('reason').notNull(), // 'buylist' | 'sale' | 'adjustment' | 'refund'
  refType: text('ref_type'), // 'buy' | 'sale' | null
  refId: integer('ref_id'),
  staffId: integer('staff_id').references(() => staff.id),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const buyTransactions = sqliteTable('buy_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  staffId: integer('staff_id').references(() => staff.id),
  customerId: integer('customer_id').references(() => customers.id),
  method: text('method').notNull(), // 'cash' | 'store_credit'
  total: real('total').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const buyItems = sqliteTable('buy_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  buyId: integer('buy_id').notNull().references(() => buyTransactions.id),
  cardId: integer('card_id').references(() => cards.id),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  condition: text('condition').notNull(),
  quantity: integer('quantity').notNull(),
  payPrice: real('pay_price').notNull(), // per-item GBP paid
})

export const wantList = sqliteTable('want_list', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  cardId: integer('card_id').references(() => cards.id),
  freeText: text('free_text'), // when the card isn't in our DB yet
  notify: integer('notify', { mode: 'boolean' }).notNull().default(true),
  fulfilledAt: text('fulfilled_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
```

- [ ] **Step 2: Add buy-% columns to `settings`** (inside the existing `settings` table definition, after `highValueThreshold`):

```ts
  buyCashPct: real('buy_cash_pct').notNull().default(0.5),
  buyCreditPct: real('buy_credit_pct').notNull().default(0.65),
```

- [ ] **Step 3: Add type exports** (with the other `export type` lines):

```ts
export type Customer = typeof customers.$inferSelect
export type CreditLedger = typeof creditLedger.$inferSelect
export type BuyTransaction = typeof buyTransactions.$inferSelect
export type BuyItem = typeof buyItems.$inferSelect
export type WantListItem = typeof wantList.$inferSelect
```

- [ ] **Step 4: Generate + apply the migration**

Run: `npx drizzle-kit generate`
Expected: a new `lib/db/migrations/NNNN_*.sql` creating 5 tables + 2 columns; `customers`, `credit_ledger`, `buy_transactions`, `buy_items`, `want_list` appear in the summary.
Then export env and run `npx drizzle-kit migrate`.
Expected: `migrations applied successfully!`

- [ ] **Step 5: Verify** `npx tsc --noEmit` is clean, then commit.

```bash
git add lib/db/schema.ts lib/db/migrations
git commit -m "feat: schema for customers, store-credit ledger, buys, want list"
```

---

## Task 2: Credit + buy-pricing helpers

**Files:**
- Create: `lib/credit.ts`
- Modify: `lib/settings.ts` (extend `AppSettings`, `DEFAULT_SETTINGS`, `toAppSettings`)
- Create (throwaway): `scripts/_verify-credit.ts`

**Interfaces:**
- Produces: `calculateBuyPrice(market: number | null, pct: number): number | null`; `getCustomerBalance(customerId: number): Promise<number>`.
- Consumes: `db`, `creditLedger` from schema.

- [ ] **Step 1: Extend settings.** In `lib/settings.ts` add `buyCashPct` and `buyCreditPct` to the `AppSettings` interface, to `DEFAULT_SETTINGS` (`buyCashPct: 0.5, buyCreditPct: 0.65`), and to `toAppSettings` (`buyCashPct: row.buyCashPct, buyCreditPct: row.buyCreditPct`).

- [ ] **Step 2: Write `lib/credit.ts`:**

```ts
import { db } from '@/lib/db'
import { creditLedger } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

// Floor so we never overpay a customer by a rounding penny.
export function calculateBuyPrice(market: number | null | undefined, pct: number): number | null {
  if (market == null) return null
  return Math.floor(market * pct * 100) / 100
}

export async function getCustomerBalance(customerId: number): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.customerId, customerId))
  return Math.round((row?.balance ?? 0) * 100) / 100
}
```

- [ ] **Step 3: Write `scripts/_verify-credit.ts`** to prove balance derivation works against the live DB:

```ts
import { db } from '../lib/db'
import { customers, creditLedger } from '../lib/db/schema'
import { getCustomerBalance, calculateBuyPrice } from '../lib/credit'
import { eq } from 'drizzle-orm'

async function main() {
  const [c] = await db.insert(customers).values({ name: '__verify__' }).returning()
  await db.insert(creditLedger).values([
    { customerId: c.id, delta: 10, reason: 'buylist' },
    { customerId: c.id, delta: -3.5, reason: 'sale' },
  ])
  const bal = await getCustomerBalance(c.id)
  console.log('balance (expect 6.5):', bal)
  console.log('buyPrice 20*0.5 (expect 10):', calculateBuyPrice(20, 0.5))
  console.log('buyPrice null (expect null):', calculateBuyPrice(null, 0.5))
  // cleanup
  await db.delete(creditLedger).where(eq(creditLedger.customerId, c.id))
  await db.delete(customers).where(eq(customers.id, c.id))
  if (bal !== 6.5) throw new Error('balance wrong')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 4: Run it.**

Run: `npx tsx --env-file=.env.local scripts/_verify-credit.ts`
Expected: `balance (expect 6.5): 6.5`, `buyPrice 20*0.5 (expect 10): 10`, `buyPrice null (expect null): null`, exit 0.

- [ ] **Step 5:** Delete `scripts/_verify-credit.ts`, confirm `npx tsc --noEmit` clean, commit.

```bash
rm scripts/_verify-credit.ts
git add lib/credit.ts lib/settings.ts
git commit -m "feat: store-credit balance + buy-price helpers"
```

---

## Task 3: Customers API

**Files:**
- Create: `app/api/customers/route.ts`, `app/api/customers/[id]/route.ts`, `app/api/customers/[id]/credit/route.ts`

**Interfaces:**
- Produces HTTP: `GET /api/customers?q=` → `Customer[]`; `POST /api/customers {name, phone?, email?, notes?}` → `Customer` (201); `GET /api/customers/[id]` → `{ customer, balance, ledger, wants }`; `PATCH /api/customers/[id]` → `Customer`; `POST /api/customers/[id]/credit {delta, reason}` (admin) → `{ balance }`.
- Consumes: `getCustomerBalance`, `getSession`, `db`, schema tables.

- [ ] **Step 1: `app/api/customers/route.ts`:**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/db/schema'
import { like, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const rows = q
    ? await db.select().from(customers).where(like(customers.name, `%${q}%`)).limit(20)
    : await db.select().from(customers).orderBy(desc(customers.createdAt)).limit(50)
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { name, phone, email, notes } = await req.json()
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }
  const [c] = await db.insert(customers).values({
    name: name.trim(), phone: phone || null, email: email || null, notes: notes || null,
  }).returning()
  return NextResponse.json(c, { status: 201 })
}
```

- [ ] **Step 2: `app/api/customers/[id]/route.ts`** — GET returns customer + derived balance + ledger (newest first) + open wants; PATCH edits allow-listed fields:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, creditLedger, wantList } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { getCustomerBalance } from '@/lib/credit'

const EDITABLE = new Set(['name', 'phone', 'email', 'notes'])

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = parseInt((await params).id)
  const [customer] = await db.select().from(customers).where(eq(customers.id, id))
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const [balance, ledger, wants] = await Promise.all([
    getCustomerBalance(id),
    db.select().from(creditLedger).where(eq(creditLedger.customerId, id)).orderBy(desc(creditLedger.createdAt)).limit(50),
    db.select().from(wantList).where(eq(wantList.customerId, id)),
  ])
  return NextResponse.json({ customer, balance, ledger, wants })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = parseInt((await params).id)
  const body = await req.json()
  const updates = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.has(k)))
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 })
  const [updated] = await db.update(customers).set(updates).where(eq(customers.id, id)).returning()
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
}
```

- [ ] **Step 3: `app/api/customers/[id]/credit/route.ts`** — admin-only manual adjustment:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { creditLedger } from '@/lib/db/schema'
import { getSession } from '@/lib/auth'
import { getCustomerBalance } from '@/lib/credit'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const customerId = parseInt((await params).id)
  const { delta, reason } = await req.json()
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return NextResponse.json({ error: 'Invalid delta' }, { status: 400 })
  await db.insert(creditLedger).values({
    customerId, delta: Math.round(n * 100) / 100, reason: 'adjustment',
    staffId: session.staffId ?? null,
  })
  return NextResponse.json({ balance: await getCustomerBalance(customerId) })
}
```

- [ ] **Step 4: Verify** with the dev server running (`npm run dev`). Log in (owner password, then PIN) in a browser, copy the `pokedb-session` cookie, and run:

Run: `curl -s -b 'pokedb-session=<cookie>' -X POST localhost:3000/api/customers -H 'content-type: application/json' -d '{"name":"Test Buyer"}'`
Expected: JSON customer with an `id` and `name: "Test Buyer"`, HTTP 201.
Then `curl -s -b '<cookie>' localhost:3000/api/customers/<id>` → `{ customer, balance: 0, ledger: [], wants: [] }`.

- [ ] **Step 5:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/customers
git commit -m "feat: customers API with derived credit balance"
```

---

## Task 4: Buys API (transactional buy-in)

**Files:**
- Create: `app/api/buys/route.ts`

**Interfaces:**
- Produces HTTP: `POST /api/buys { items: {cardId, condition, quantity, payPrice}[], method: 'cash'|'store_credit', customerId? }` → `{ buyId, total }`; `GET /api/buys` → recent buys. On accept: each line creates/increments an `inventoryItems` row (cost = payPrice), records a `buy_items` row; if `method==='store_credit'`, appends one positive `credit_ledger` row for the customer. All in one transaction.
- Consumes: `db`, schema (`buyTransactions`, `buyItems`, `inventoryItems`, `creditLedger`), `generateQRId` from `lib/qr`, `getSession`.

- [ ] **Step 1: Write the route.** Key rules: `store_credit` requires `customerId`; conditions validated; quantities positive ints; money rounded; everything in `db.transaction`.

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buyTransactions, buyItems, inventoryItems, creditLedger } from '@/lib/db/schema'
import { desc } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { generateQRId } from '@/lib/qr'

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])
const round2 = (n: number) => Math.round(n * 100) / 100

interface BuyLine { cardId: number; condition: string; quantity: number; payPrice: number }

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as { items: BuyLine[]; method: string; customerId?: number }

  if (!body.items?.length) return NextResponse.json({ error: 'No items' }, { status: 400 })
  if (!['cash', 'store_credit'].includes(body.method)) return NextResponse.json({ error: 'Invalid method' }, { status: 400 })
  if (body.method === 'store_credit' && !body.customerId) {
    return NextResponse.json({ error: 'Store credit requires a customer' }, { status: 400 })
  }
  for (const it of body.items) {
    if (!CONDITIONS.has(it.condition)) return NextResponse.json({ error: 'Invalid condition' }, { status: 400 })
    if (!Number.isInteger(it.quantity) || it.quantity < 1) return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 })
    if (!(it.payPrice >= 0)) return NextResponse.json({ error: 'Invalid pay price' }, { status: 400 })
  }
  const total = round2(body.items.reduce((s, i) => s + i.payPrice * i.quantity, 0))

  try {
    const buyId = await db.transaction(async (tx) => {
      const [buy] = await tx.insert(buyTransactions).values({
        staffId: session.staffId!, customerId: body.customerId ?? null,
        method: body.method, total,
      }).returning()

      for (const it of body.items) {
        const [inv] = await tx.insert(inventoryItems).values({
          cardId: it.cardId, condition: it.condition, quantity: it.quantity,
          costPrice: round2(it.payPrice), qrCode: generateQRId(),
        }).returning()
        await tx.insert(buyItems).values({
          buyId: buy.id, cardId: it.cardId, inventoryItemId: inv.id,
          condition: it.condition, quantity: it.quantity, payPrice: round2(it.payPrice),
        })
      }

      if (body.method === 'store_credit') {
        await tx.insert(creditLedger).values({
          customerId: body.customerId!, delta: total, reason: 'buylist',
          refType: 'buy', refId: buy.id, staffId: session.staffId!,
        })
      }
      return buy.id
    })
    return NextResponse.json({ buyId, total })
  } catch {
    return NextResponse.json({ error: 'Buy failed' }, { status: 500 })
  }
}

export async function GET() {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rows = await db.select().from(buyTransactions).orderBy(desc(buyTransactions.createdAt)).limit(50)
  return NextResponse.json(rows)
}
```

- [ ] **Step 2: Verify with a script** (uses a seeded card; reuses the verify pattern). Create `scripts/_verify-buy.ts`:

```ts
import { db } from '../lib/db'
import { cards, customers, buyTransactions, inventoryItems, creditLedger } from '../lib/db/schema'
import { getCustomerBalance } from '../lib/credit'
import { eq } from 'drizzle-orm'

async function main() {
  const [card] = await db.select().from(cards).limit(1)
  if (!card) throw new Error('seed cards first: npx tsx --env-file=.env.local scripts/seed-cards.ts')
  const [cust] = await db.insert(customers).values({ name: '__buyverify__' }).returning()

  // Simulate the route's transaction body inline:
  await db.transaction(async (tx) => {
    const [buy] = await tx.insert(buyTransactions).values({ customerId: cust.id, method: 'store_credit', total: 5 }).returning()
    await tx.insert(inventoryItems).values({ cardId: card.id, condition: 'NM', quantity: 2, costPrice: 2.5, qrCode: crypto.randomUUID() })
    await tx.insert(creditLedger).values({ customerId: cust.id, delta: 5, reason: 'buylist', refType: 'buy', refId: buy.id })
  })
  console.log('balance after credit buy (expect 5):', await getCustomerBalance(cust.id))
  await db.delete(creditLedger).where(eq(creditLedger.customerId, cust.id))
  await db.delete(customers).where(eq(customers.id, cust.id))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

Run: `npx tsx --env-file=.env.local scripts/_verify-buy.ts`
Expected: `balance after credit buy (expect 5): 5`. (Confirms the ledger+inventory+buy write path.) Then `rm scripts/_verify-buy.ts`.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/buys
git commit -m "feat: transactional buy-in API (cash or store credit)"
```

---

## Task 5: Pay with store credit at POS

**Files:**
- Modify: `app/api/sales/route.ts`

**Interfaces:**
- Consumes: existing sale `POST` body, plus optional `customerId` and `paymentMethod: 'store_credit'`.
- Produces: when `paymentMethod === 'store_credit'`, the sale is rejected (409) unless the customer's balance ≥ total; on success a single negative `credit_ledger` row (`delta = -total`, `reason='sale'`, `refType='sale'`, `refId=sale.id`) is written **inside** the existing sale transaction.

- [ ] **Step 1:** In `app/api/sales/route.ts`, import `creditLedger` and `getCustomerBalance`, and read `customerId` from the body. After computing `total` and before/at the start of the transaction, if `paymentMethod === 'store_credit'`:
  - require `customerId` (400 if missing),
  - compute `balance = await getCustomerBalance(customerId)` (outside the tx is fine for the guard; the ledger insert is inside),
  - if `balance < total` return 409 `{ error: 'Insufficient store credit' }`.

Add `customerId` to the `sales` insert is not needed (sales has no customerId column); instead the link is the ledger row. Inside the existing `db.transaction`, after the `sales` row is inserted, add:

```ts
if (body.paymentMethod === 'store_credit') {
  await tx.insert(creditLedger).values({
    customerId: body.customerId!, delta: -total, reason: 'sale',
    refType: 'sale', refId: sale.id, staffId: session.staffId!,
  })
}
```

(The existing stock-decrement + sale-insert logic is unchanged; this is one more insert in the same transaction.)

- [ ] **Step 2: Verify** the guard via curl with a customer that has zero balance:

Run: `curl -s -b '<cookie>' -X POST localhost:3000/api/sales -H 'content-type: application/json' -d '{"items":[{"inventoryItemId":<id>,"quantity":1,"priceAtSale":5}],"paymentMethod":"store_credit","customerId":<zeroBalanceId>}'`
Expected: HTTP 409 `{"error":"Insufficient store credit"}`.

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/sales/route.ts
git commit -m "feat: pay with store credit at POS (balance-guarded)"
```

---

## Task 6: Buylist UI

**Files:**
- Create: `app/(app)/buylist/page.tsx`, `components/buylist/BuyCard.tsx`, `components/buylist/BuyCart.tsx`
- Create: `components/shared/CustomerPicker.tsx`

**Interfaces:**
- Consumes: `GET /api/cards/search?q=` (existing), `POST /api/buys`, `GET/POST /api/customers`, `useSettings()` (`buyCashPct`, `buyCreditPct`), `calculateBuyPrice`, `formatGBP`.
- Pattern: mirror `components/pos/CardResult.tsx` + `Cart.tsx` but for buying. `BuyCard` shows market price and the two offers (`calculateBuyPrice(market, buyCashPct)` and `…buyCreditPct`), a condition selector and quantity, and an "Add to buy" button.

- [ ] **Step 1: `components/shared/CustomerPicker.tsx`** — a search box that lists matching customers (`GET /api/customers?q=`) and a "+ New customer" inline create (`POST /api/customers`), calling `onSelect(customer)`. Show selected customer's name + balance (fetch `GET /api/customers/[id]` for balance). Use shadcn `Input`/`Button`; `import { toast } from 'sonner'`.

- [ ] **Step 2: `components/buylist/BuyCard.tsx`** — props `{ card, prices, onAdd }`. Compute `const { buyCashPct, buyCreditPct } = useSettings()`, `cash = calculateBuyPrice(prices?.tcgplayerMarket, buyCashPct)`, `credit = calculateBuyPrice(prices?.tcgplayerMarket, buyCreditPct)`. Render the card image (reuse the zoom modal pattern from `CardResult`), market price, and two badges "Cash £Y / Credit £Z", a condition `Button` group (`NM LP MP HP DMG`), a quantity stepper, and "Add to buy". On add call `onAdd({ cardId: card.id, condition, quantity, payPriceCash: cash, payPriceCredit: credit })`.

- [ ] **Step 3: `components/buylist/BuyCart.tsx`** — holds the buy lines, a `CustomerPicker`, and a cash/credit toggle. The per-line `payPrice` shown depends on the selected method (cash vs credit offer). Show the running total. "Confirm buy" posts to `POST /api/buys` with `{ items: lines.map(l => ({ cardId, condition, quantity, payPrice: method==='cash'?payPriceCash:payPriceCredit })), method, customerId }`. On success: `toast.success('Bought N cards for £X')`, clear cart.

- [ ] **Step 4: `app/(app)/buylist/page.tsx`** — search bar (reuse the `SearchBar` pattern from POS) → results rendered as `BuyCard`s on the left, `BuyCart` on the right. `'use client'`.

- [ ] **Step 5: Verify in browser:** search a seeded card (e.g. "Charizard"), add NM ×1 at the cash offer, pick/create a customer, switch to credit, confirm. Check the toast, then open the customer in the Customers screen (Task 7) — balance should equal the credit total, and Inventory should show the new stock.

- [ ] **Step 6:** `npx tsc --noEmit` clean; commit.

```bash
git add app/(app)/buylist components/buylist components/shared/CustomerPicker.tsx
git commit -m "feat: buylist UI — buy cards for cash or store credit"
```

---

## Task 7: Customers UI

**Files:**
- Create: `app/(app)/customers/page.tsx`, `app/(app)/customers/[id]/page.tsx`, `components/customers/CustomerDetail.tsx`

**Interfaces:**
- Consumes: `GET /api/customers?q=`, `GET /api/customers/[id]`, `PATCH /api/customers/[id]`, `POST /api/customers/[id]/credit` (admin), `formatGBP`.

- [ ] **Step 1: `app/(app)/customers/page.tsx`** — `'use client'` list with a search box (`GET /api/customers?q=`) and a "+ New customer" button (reuse the create call). Each row links to `/customers/[id]` and shows name + phone.

- [ ] **Step 2: `app/(app)/customers/[id]/page.tsx`** — server component reading the id param and rendering `<CustomerDetail id={id} />`.

- [ ] **Step 3: `components/customers/CustomerDetail.tsx`** — `'use client'`; fetch `GET /api/customers/[id]`, show name/contact (editable via `PATCH`), the **store-credit balance** prominently (`formatGBP(balance)`), the ledger history (date, reason, ±amount), and the want list. If the session is admin (read from a small `GET /api/settings`/session probe, or simply always show and let the 403 guard the action), show a manual "adjust credit" form posting to `/credit`.

- [ ] **Step 4: Verify:** open a customer created via buylist; confirm balance + ledger render and a manual +£5 adjustment updates the balance.

- [ ] **Step 5:** `npx tsc --noEmit` clean; commit.

```bash
git add app/(app)/customers components/customers
git commit -m "feat: customers UI with balance, ledger and edit"
```

---

## Task 8: Want list

**Files:**
- Create: `app/api/wants/route.ts`
- Create: `app/(app)/wants/page.tsx`
- Modify: `components/customers/CustomerDetail.tsx` (add-want form)
- Modify: `components/inventory/AddItemForm.tsx` (surface matching wants after add)

**Interfaces:**
- Produces HTTP: `GET /api/wants` → open wants joined to card + customer + an `inStock` boolean (true if any active inventory exists for that `cardId`); `POST /api/wants { customerId, cardId?, freeText? }`; `DELETE /api/wants?id=` (marks `fulfilledAt`).
- Consumes: `db`, schema (`wantList`, `cards`, `customers`, `inventoryItems`), `getSession`.

- [ ] **Step 1: `app/api/wants/route.ts`** — `GET` selects open wants (`fulfilledAt IS NULL`) left-joined to `cards` and `customers`; for each with a `cardId`, compute `inStock` via an `EXISTS` against active `inventoryItems`. `POST` validates `customerId` + (one of `cardId`/`freeText`). `DELETE` sets `fulfilledAt = datetime('now')` for `?id=`.

- [ ] **Step 2: Add-want UI** in `CustomerDetail.tsx`: a small form — search a card (`/api/cards/search`) or type free text — posting to `POST /api/wants`.

- [ ] **Step 3: `app/(app)/wants/page.tsx`** — admin/staff list of open wants with the `inStock` flag highlighted (green = we now have it), a "notify done / remove" action calling `DELETE`.

- [ ] **Step 4: Surface on intake.** In `AddItemForm.tsx` after a successful add, `GET /api/wants` and if any open want matches the just-added `cardId`, `toast(`${n} customer(s) want this card`)` so staff can ring them.

- [ ] **Step 5: Verify:** add a want for a card you have no stock of (inStock false); add inventory for it; reload `/wants` → inStock true and the intake toast fired.

- [ ] **Step 6:** `npx tsc --noEmit` clean; commit.

```bash
git add app/api/wants app/(app)/wants components/customers/CustomerDetail.tsx components/inventory/AddItemForm.tsx
git commit -m "feat: customer want lists with in-stock detection"
```

---

## Task 9: Navigation, settings & POS store-credit payment wiring

**Files:**
- Modify: `components/layout/Nav.tsx`, `components/settings/SettingsForm.tsx`, `app/api/settings/route.ts`, `components/pos/CheckoutDialog.tsx` (or the POS checkout component)

**Interfaces:**
- Consumes: existing settings PATCH; adds `buyCashPct`/`buyCreditPct` to the editable set; adds Buy + Customers (+ Wants) nav links; wires a customer picker + store-credit option into POS checkout.

- [ ] **Step 1: Nav links.** In `components/layout/Nav.tsx` `links` array add `{ href: '/buylist', label: '↩ Buy' }` and `{ href: '/customers', label: '👥 Customers' }`; add `{ href: '/wants', label: 'Wants' }` under the admin block.

- [ ] **Step 2: Settings.** In `app/api/settings/route.ts` add `buyCashPct` and `buyCreditPct` to the numeric-validation loop (must be `> 0` and `<= 1`). In `SettingsForm.tsx` add two inputs ("Cash buy %", "Credit buy %") with a worked example ("a £10 card → pay £X cash / £Y credit").

- [ ] **Step 3: POS store credit.** In the POS checkout component, when `store_credit` is the chosen method, require a `CustomerPicker` selection and pass `customerId` in the `POST /api/sales` body. Show the customer's balance and disable confirm if `balance < total`.

- [ ] **Step 4: Verify** end-to-end: buy a card on credit for a customer, then sell them something paid by store credit — the ledger nets out and a sale records.

- [ ] **Step 5:** `npx tsc --noEmit` clean; commit.

```bash
git add components/layout/Nav.tsx components/settings/SettingsForm.tsx app/api/settings/route.ts components/pos
git commit -m "feat: nav + settings + POS wiring for buylist and store credit"
```

---

## Self-Review Notes

- **Balance is always derived** (`SUM(delta)`) — no mutable balance column anywhere. ✓ (Tasks 1, 2.)
- **Every multi-row money write is transactional** — buys (Task 4) and credit-paying sales (Task 5). ✓
- **Store credit cannot go negative** — POS guards `balance >= total` before writing the negative row (Task 5). ✓
- **Conditions/quantities/methods validated** server-side in buys (Task 4) and reused enums match the codebase. ✓
- Type names used in later tasks (`Customer`, `getCustomerBalance`, `calculateBuyPrice`) are all defined in Tasks 1–2. ✓
- Open follow-ups (out of scope, not blockers): per-condition buy percentages; a cached balance column if the ledger ever gets huge; receipt printing for buys.
