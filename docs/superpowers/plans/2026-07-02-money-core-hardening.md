# Money-Core Hardening (Package A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the three money-critical flows (sale, refund, buy) out of route handlers into a tested `lib/domain/` layer with server-canonical pricing, typed errors, and uniform auth helpers.

**Architecture:** Plain transactional functions in `lib/domain/` (no classes, no repositories), each accepting an optional Drizzle db handle so tests inject an in-memory libSQL database built from the real migration files. Routes shrink to parse → auth → call domain → map `DomainError` codes to HTTP statuses via one shared wrapper. The POS client stops sending prices; the server computes canonical line prices and rejects stale tills with `PRICE_CHANGED`.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle ORM, node:test + tsx runner, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-07-02-risk-fixes-design.md` (Package A section).

## Global Constraints

- Node 24 LTS; Next.js 16 App Router only; TypeScript strict; **no new npm dependencies**.
- Money in Package A stays **pounds as SQLite `real`, 2dp** (pence conversion is Package B — do not convert units here). `round2 = (n: number) => Math.round(n * 100) / 100`.
- Conditions: `NM | LP | MP | HP | DMG`. Currency GBP.
- Ponytail mode: write the simplest code that passes; no speculative abstraction, no extra options, no unrequested features.
- The `@/*` path alias resolves under `node --import tsx --test` (verified) — use it in `lib/` code as the codebase already does; test files use relative imports like the existing `lib/pricing.test.ts`.
- Existing behavior to preserve verbatim unless a task says otherwise: guarded stock decrement (quantity can never go negative), refund quantity caps, buy merge-on-intake cost blending.

---

### Task 1: In-memory DB test harness

**Files:**
- Modify: `lib/db/index.ts` (export `Db` type)
- Modify: `package.json` (test script env var)
- Create: `lib/db/test-helpers.ts`
- Test: `lib/db/test-helpers.test.ts`

**Interfaces:**
- Produces: `createTestDb(): Promise<Db>` — in-memory libSQL with all migrations applied; `seedBase(dbc: Db): Promise<void>` — inserts staff #1, card #1, settings row #1; `export type Db` from `lib/db`.

- [ ] **Step 1: Export the `Db` type and make the test script safe to run without Turso env**

In `lib/db/index.ts` add at the bottom:

```ts
export type Db = typeof db
```

In `package.json` change the test script (importing `lib/db` in tests must not crash on missing `TURSO_DATABASE_URL`; the real client is never used by tests):

```json
"test": "TURSO_DATABASE_URL=:memory: node --import tsx --test \"**/*.test.ts\""
```

- [ ] **Step 2: Write the failing test**

`lib/db/test-helpers.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from './test-helpers'
import * as schema from './schema'

test('createTestDb applies all migrations and supports inserts', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const [staffRow] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, 1))
  assert.equal(staffRow.name, 'Tess')
  const [card] = await dbc.select().from(schema.cards).where(eq(schema.cards.id, 1))
  assert.equal(card.name, 'Pikachu')
  // refunds table only exists if the latest migrations ran
  const rows = await dbc.select().from(schema.refunds)
  assert.deepEqual(rows, [])
})

test('two test dbs are isolated', async () => {
  const a = await createTestDb()
  const b = await createTestDb()
  await seedBase(a)
  assert.deepEqual(await b.select().from(schema.staff), [])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- lib/db/test-helpers.test.ts` (or `npm test` — the glob picks it up)
Expected: FAIL — cannot find module `./test-helpers`

- [ ] **Step 4: Write the harness**

`lib/db/test-helpers.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'
import type { Db } from './index'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

// Fresh in-memory database with every migration applied in journal order.
export async function createTestDb(): Promise<Db> {
  const client = createClient({ url: ':memory:' })
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] }
  for (const { tag } of journal.entries) {
    const migration = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.execute(trimmed)
    }
  }
  return drizzle(client, { schema })
}

// Minimal shared fixtures: one staff member, one card, the settings row
// (schema defaults: marginMultiplier 0.85, primaryPriceSource 'cardmarket').
export async function seedBase(dbc: Db): Promise<void> {
  await dbc.insert(schema.staff).values({ id: 1, name: 'Tess', pinHash: 'x', role: 'staff' })
  await dbc.insert(schema.cards).values({ id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102' })
  await dbc.insert(schema.settings).values({ id: 1 })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (both new tests plus the existing 10 in `lib/pricing.test.ts`)

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add lib/db/index.ts lib/db/test-helpers.ts lib/db/test-helpers.test.ts package.json
git commit -m "test: in-memory libSQL harness applying real migrations"
```

---

### Task 2: DomainError, route guard, auth helpers

**Files:**
- Create: `lib/domain/errors.ts`
- Create: `lib/api.ts`
- Modify: `lib/auth.ts` (append helpers)
- Test: `lib/domain/errors.test.ts`

**Interfaces:**
- Produces:
  - `class DomainError extends Error { code: DomainErrorCode; meta?: Record<string, unknown> }` with `new DomainError(code, message, meta?)`
  - `toHttpError(e: unknown): { status: number; body: { error: string; code: DomainErrorCode; meta?: Record<string, unknown> } } | null`
  - `guarded(handler)` — route wrapper converting thrown `DomainError`s to JSON responses, everything else to 500
  - `requireOwner(session): SessionData`, `requireStaff(session): SessionData & { staffId: number }`, `requireAdmin(session): SessionData & { staffId: number }` — return the session or throw `DomainError('UNAUTHORIZED')` / `DomainError('FORBIDDEN')`

- [ ] **Step 1: Write the failing test**

`lib/domain/errors.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainError, toHttpError } from './errors'
import { requireOwner, requireStaff, requireAdmin, type SessionData } from '../auth'

// assert.throws/rejects predicates take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

test('toHttpError maps codes to statuses', () => {
  assert.equal(toHttpError(new DomainError('INVALID_INPUT', 'bad'))!.status, 400)
  assert.equal(toHttpError(new DomainError('UNAUTHORIZED', 'no'))!.status, 401)
  assert.equal(toHttpError(new DomainError('FORBIDDEN', 'no'))!.status, 403)
  assert.equal(toHttpError(new DomainError('NOT_FOUND', 'gone'))!.status, 404)
  for (const code of ['INSUFFICIENT_STOCK', 'PRICE_CHANGED', 'INSUFFICIENT_CREDIT', 'NO_PRICE', 'BAD_LINE'] as const) {
    assert.equal(toHttpError(new DomainError(code, 'conflict'))!.status, 409)
  }
})

test('toHttpError passes message, code and meta through; null for non-domain errors', () => {
  const mapped = toHttpError(new DomainError('INSUFFICIENT_STOCK', 'no stock', { inventoryItemId: 7 }))!
  assert.deepEqual(mapped.body, { error: 'no stock', code: 'INSUFFICIENT_STOCK', meta: { inventoryItemId: 7 } })
  assert.equal(toHttpError(new Error('boom')), null)
  assert.equal(toHttpError('boom'), null)
})

test('requireStaff / requireAdmin / requireOwner', () => {
  const anon: SessionData = { isOwnerLoggedIn: false }
  const ownerOnly: SessionData = { isOwnerLoggedIn: true }
  const staff: SessionData = { isOwnerLoggedIn: true, staffId: 2, staffRole: 'staff' }
  const admin: SessionData = { isOwnerLoggedIn: true, staffId: 1, staffRole: 'admin' }

  assert.equal(requireOwner(ownerOnly), ownerOnly)
  assert.throws(() => requireOwner(anon), domainCode('UNAUTHORIZED'))

  assert.equal(requireStaff(staff).staffId, 2)
  assert.throws(() => requireStaff(ownerOnly), domainCode('UNAUTHORIZED'))

  assert.equal(requireAdmin(admin).staffId, 1)
  // Deliberate tightening: a device-unlocked owner cookie alone no longer
  // satisfies admin checks — an admin PIN session is required.
  assert.throws(() => requireAdmin(ownerOnly), domainCode('UNAUTHORIZED'))
  assert.throws(() => requireAdmin(staff), domainCode('FORBIDDEN'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./errors`

- [ ] **Step 3: Implement**

`lib/domain/errors.ts`:

```ts
export type DomainErrorCode =
  | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'INSUFFICIENT_CREDIT'
  | 'NO_PRICE' | 'BAD_LINE' | 'NOT_FOUND' | 'INVALID_INPUT'
  | 'UNAUTHORIZED' | 'FORBIDDEN'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

const STATUS: Record<DomainErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_CREDIT: 409,
  NO_PRICE: 409,
  BAD_LINE: 409,
}

// Framework-free mapping so domain tests never import next/server.
export function toHttpError(e: unknown):
  | { status: number; body: { error: string; code: DomainErrorCode; meta?: Record<string, unknown> } }
  | null {
  if (!(e instanceof DomainError)) return null
  return {
    status: STATUS[e.code],
    body: { error: e.message, code: e.code, ...(e.meta ? { meta: e.meta } : {}) },
  }
}
```

`lib/api.ts`:

```ts
import { NextResponse } from 'next/server'
import { toHttpError } from '@/lib/domain/errors'

// Wraps a route handler: DomainErrors become their mapped JSON response,
// anything else is logged and becomes a generic 500.
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      const mapped = toHttpError(e)
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
      console.error('Unhandled route error:', e)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
  }
}
```

Append to `lib/auth.ts`:

```ts
import { DomainError } from '@/lib/domain/errors'

// Device unlocked (owner password) — pre-PIN surfaces like the PIN pad's staff list.
export function requireOwner(session: SessionData): SessionData {
  if (!session.isOwnerLoggedIn) throw new DomainError('UNAUTHORIZED', 'Login required')
  return session
}

export function requireStaff(session: SessionData): SessionData & { staffId: number } {
  if (!session.staffId) throw new DomainError('UNAUTHORIZED', 'Staff PIN required')
  return session as SessionData & { staffId: number }
}

// Admin PIN session required. Note: this deliberately tightens the old
// hand-rolled checks, which accepted any device-unlocked session as admin.
export function requireAdmin(session: SessionData): SessionData & { staffId: number } {
  const s = requireStaff(session)
  if (s.staffRole !== 'admin') throw new DomainError('FORBIDDEN', 'Admin only')
  return s
}
```

(Move the `import` to the top of `lib/auth.ts` with the existing imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add lib/domain/errors.ts lib/domain/errors.test.ts lib/api.ts lib/auth.ts
git commit -m "feat: DomainError with HTTP mapping, guarded route wrapper, auth helpers"
```

---

### Task 3: `cost_at_sale` column on sale_items

**Files:**
- Modify: `lib/db/schema.ts` (saleItems table)
- Create: `lib/db/migrations/0006_*.sql` (generated)

**Interfaces:**
- Produces: `saleItems.costAtSale: real('cost_at_sale')` nullable — snapshot of the inventory item's `cost_price` at sale time. Consumed by Task 4 (`createSale` writes it) and later by Package B margin groundwork.

- [ ] **Step 1: Add the column**

In `lib/db/schema.ts`, change the `saleItems` table to:

```ts
export const saleItems = sqliteTable('sale_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  quantity: integer('quantity').notNull(),
  priceAtSale: real('price_at_sale').notNull(),
  costAtSale: real('cost_at_sale'), // cost_price snapshot; VAT-margin groundwork
})
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate --name cost-at-sale`
Expected: new file `lib/db/migrations/0006_cost-at-sale.sql` containing `ALTER TABLE \`sale_items\` ADD \`cost_at_sale\` real;` and an updated journal entry.

- [ ] **Step 3: Verify the harness picks it up**

Run: `npm test`
Expected: PASS — `test-helpers.test.ts` applies migrations from the journal, so 0006 now runs in the harness too.

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Apply to the dev database**

Run: `npx drizzle-kit migrate`
Expected: migration applied without error (pre-launch test data only).

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/
git commit -m "feat: cost_at_sale snapshot column on sale_items"
```

---

### Task 4: `createSale` domain function (server-canonical pricing)

**Files:**
- Modify: `lib/settings.ts` (inject db handle)
- Create: `lib/domain/sales.ts`
- Test: `lib/domain/sales.test.ts`

**Interfaces:**
- Consumes: `Db`/`createTestDb`/`seedBase` (Task 1), `DomainError` (Task 2), `saleItems.costAtSale` (Task 3), existing `calculateSellPrice`/`pickMarketPrice` from `lib/pricing.ts`, `getSettings` from `lib/settings.ts`.
- Produces:
  ```ts
  interface CreateSaleInput {
    staffId: number
    items: { inventoryItemId: number; quantity: number }[]
    paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
    discount: number          // pounds, whole-sale discount
    customerId?: number       // required for store_credit
    expectedTotal: number     // what the till displayed
  }
  function createSale(input: CreateSaleInput, dbc?: Db): Promise<{ saleId: number; total: number }>
  ```
  Also: `getSettings(dbc?: Db)` gains the optional handle (defaults to the app db; behavior unchanged for existing callers).

- [ ] **Step 1: Add the db-handle parameter to getSettings**

In `lib/settings.ts`, change the two functions to accept a handle (`updateSettings` keeps using the app db):

```ts
import { db, type Db } from '@/lib/db'
```

```ts
export async function getSettings(dbc: Db = db): Promise<AppSettings> {
  try {
    const [row] = await dbc.select().from(settings).where(eq(settings.id, 1)).limit(1)
    if (row) return toAppSettings(row)

    const [created] = await dbc.insert(settings)
      .values({ id: 1, ...DEFAULT_SETTINGS })
      .onConflictDoNothing()
      .returning()
    if (created) return toAppSettings(created)

    // A concurrent call created it — read again.
    const [row2] = await dbc.select().from(settings).where(eq(settings.id, 1)).limit(1)
    return row2 ? toAppSettings(row2) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}
```

Run: `npx tsc --noEmit` — expected: no errors (all existing callers pass zero args).

- [ ] **Step 2: Write the failing tests**

`lib/domain/sales.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale, type CreateSaleInput } from './sales'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

// Predicates for assert.rejects take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  // card 1 priced at CM trend £10 → sell = ceil(10 × 0.85) = £8.50
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 10 })
  // 5 in stock, cost £3, no override
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 3, qrCode: 'qr-1',
  })
})

const base: CreateSaleInput = {
  staffId: 1,
  items: [{ inventoryItemId: 1, quantity: 2 }],
  paymentMethod: 'cash',
  discount: 0,
  expectedTotal: 17, // 2 × 8.50
}

async function stockOf(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.quantity
}

test('happy path: server computes price from market, decrements stock, snapshots cost', async () => {
  const { saleId, total } = await createSale(base, dbc)
  assert.equal(total, 17)
  assert.equal(await stockOf(1), 3)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId))
  assert.equal(sale.subtotal, 17)
  assert.equal(sale.vatScheme, 'none')
  assert.equal(sale.vatAmount, 0)
  const items = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId))
  assert.equal(items.length, 1)
  assert.equal(items[0].priceAtSale, 8.5)
  assert.equal(items[0].costAtSale, 3)
})

test('sell_price_override beats market price', async () => {
  await dbc.update(schema.inventoryItems).set({ sellPriceOverride: 12 }).where(eq(schema.inventoryItems.id, 1))
  const { total } = await createSale({ ...base, expectedTotal: 24 }, dbc)
  assert.equal(total, 24)
})

test('NO_PRICE when neither override nor cached market price exists', async () => {
  await dbc.delete(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  await assert.rejects(
    createSale(base, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'NO_PRICE' && e.meta?.inventoryItemId === 1,
  )
  assert.equal(await stockOf(1), 5) // nothing written
})

test('PRICE_CHANGED when the till total is stale', async () => {
  await assert.rejects(
    createSale({ ...base, expectedTotal: 15 }, dbc),
    domainCode('PRICE_CHANGED'),
  )
  assert.equal(await stockOf(1), 5)
})

test('discount is clamped to the subtotal, never negative total', async () => {
  const { total } = await createSale({ ...base, discount: 999, expectedTotal: 0 }, dbc)
  assert.equal(total, 0)
})

test('INSUFFICIENT_STOCK rolls the whole sale back', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 2, cardId: 1, condition: 'LP', quantity: 1, costPrice: 1, qrCode: 'qr-2',
  })
  await assert.rejects(
    createSale({
      ...base,
      items: [
        { inventoryItemId: 1, quantity: 2 }, // fine
        { inventoryItemId: 2, quantity: 5 }, // only 1 in stock
      ],
      expectedTotal: 59.5, // 7 × 8.50 — must match, or PRICE_CHANGED fires before the stock check
    }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'INSUFFICIENT_STOCK' && e.meta?.inventoryItemId === 2,
  )
  assert.equal(await stockOf(1), 5) // line 1's decrement rolled back
  assert.equal(await stockOf(2), 1)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('store credit: balance checked inside the transaction, ledger debited', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 20, reason: 'adjustment' })
  const { saleId, total } = await createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc)
  assert.equal(total, 17)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 2)
  assert.equal(ledger[1].delta, -17)
  assert.equal(ledger[1].refId, saleId)
})

test('INSUFFICIENT_CREDIT rolls back and restores stock', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  await dbc.insert(schema.creditLedger).values({ customerId: 1, delta: 5, reason: 'adjustment' })
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit', customerId: 1 }, dbc),
    domainCode('INSUFFICIENT_CREDIT'),
  )
  assert.equal(await stockOf(1), 5)
  assert.deepEqual(await dbc.select().from(schema.sales), [])
})

test('input validation', async () => {
  await assert.rejects(createSale({ ...base, items: [] }, dbc), domainCode('INVALID_INPUT'))
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 1, quantity: 0 }] }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'iou' as never }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, paymentMethod: 'store_credit' }, dbc), // no customerId
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createSale({ ...base, items: [{ inventoryItemId: 99, quantity: 1 }] }, dbc),
    domainCode('NOT_FOUND'),
  )
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./sales`

- [ ] **Step 4: Implement `createSale`**

`lib/domain/sales.ts`:

```ts
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, priceCache, creditLedger, customers } from '@/lib/db/schema'
import { calculateSellPrice, pickMarketPrice } from '@/lib/pricing'
import { getSettings } from '@/lib/settings'
import { DomainError } from './errors'

export interface CreateSaleInput {
  staffId: number
  items: { inventoryItemId: number; quantity: number }[]
  paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
  discount: number
  customerId?: number
  expectedTotal: number
}

const PAYMENT_METHODS = new Set(['cash', 'card', 'store_credit', 'other'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function createSale(
  input: CreateSaleInput,
  dbc: Db = db,
): Promise<{ saleId: number; total: number }> {
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items')
  if (!PAYMENT_METHODS.has(input.paymentMethod)) throw new DomainError('INVALID_INPUT', 'Invalid payment method')
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    }
  }
  if (input.paymentMethod === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'customerId required for store credit')
  }

  const settings = await getSettings(dbc)

  // Server-canonical pricing: override, else market × margin. The client never sends prices.
  const ids = input.items.map(i => i.inventoryItemId)
  const rows = await dbc.select({ item: inventoryItems, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(priceCache, eq(priceCache.cardId, inventoryItems.cardId))
    .where(inArray(inventoryItems.id, ids))
  const byId = new Map(rows.map(r => [r.item.id, r]))

  const lines = input.items.map(item => {
    const row = byId.get(item.inventoryItemId)
    if (!row || !row.item.isActive) {
      throw new DomainError('NOT_FOUND', `Inventory item ${item.inventoryItemId} not found`, { inventoryItemId: item.inventoryItemId })
    }
    const unitPrice = calculateSellPrice(
      pickMarketPrice(row.prices, settings.primaryPriceSource),
      row.item.sellPriceOverride,
      settings.marginMultiplier,
    )
    if (unitPrice == null) {
      throw new DomainError('NO_PRICE', `No price for item ${item.inventoryItemId} — set a price override`, { inventoryItemId: item.inventoryItemId })
    }
    return { ...item, unitPrice, costAtSale: row.item.costPrice }
  })

  const subtotal = round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0))
  const discount = round2(Math.min(Math.max(0, input.discount ?? 0), subtotal))
  const vatAmount = 0 // shop not VAT-registered; becomes a setting in Package B
  const total = round2(subtotal - discount + vatAmount)

  if (total !== round2(input.expectedTotal)) {
    throw new DomainError('PRICE_CHANGED', `Prices changed: server total is ${total}`, { total, expectedTotal: input.expectedTotal })
  }

  if (input.paymentMethod === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const saleId = await dbc.transaction(async (tx) => {
    // Guarded decrements first — stock can never go negative; any failure rolls all back.
    for (const line of lines) {
      const decremented = await tx.update(inventoryItems)
        .set({ quantity: sql`quantity - ${line.quantity}` })
        .where(and(
          eq(inventoryItems.id, line.inventoryItemId),
          gte(inventoryItems.quantity, line.quantity),
        ))
        .returning({ id: inventoryItems.id })
      if (decremented.length === 0) {
        throw new DomainError('INSUFFICIENT_STOCK', `Insufficient stock for item ${line.inventoryItemId}`, { inventoryItemId: line.inventoryItemId })
      }
    }

    // Balance check inside the transaction so concurrent spends can't overdraw.
    if (input.paymentMethod === 'store_credit') {
      const [{ balance }] = await tx.select({ balance: sql<number>`COALESCE(SUM(delta), 0)` })
        .from(creditLedger)
        .where(eq(creditLedger.customerId, input.customerId!))
      if (round2(balance) < total) {
        throw new DomainError('INSUFFICIENT_CREDIT', 'Insufficient store credit', { balance: round2(balance), total })
      }
    }

    const [sale] = await tx.insert(sales).values({
      staffId: input.staffId,
      subtotal,
      discountAmount: discount,
      vatAmount,
      vatScheme: 'none',
      total,
      paymentMethod: input.paymentMethod,
    }).returning()

    for (const line of lines) {
      await tx.insert(saleItems).values({
        saleId: sale.id,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        priceAtSale: line.unitPrice,
        costAtSale: line.costAtSale,
      })
    }

    if (input.paymentMethod === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: -total,
        reason: 'sale',
        refType: 'sale',
        refId: sale.id,
        staffId: input.staffId,
      })
    }

    return sale.id
  })

  return { saleId, total }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all files)

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add lib/domain/sales.ts lib/domain/sales.test.ts lib/settings.ts
git commit -m "feat: createSale domain function with server-canonical pricing"
```

---

### Task 5: Rewire /api/sales and the POS client

**Files:**
- Modify: `app/api/sales/route.ts` (full rewrite, shrinks)
- Modify: `components/pos/CheckoutDialog.tsx:24,56-64` (onConfirm signature gains expectedTotal)
- Modify: `app/(app)/pos/page.tsx:90-109` (payload: no prices, adds expectedTotal; PRICE_CHANGED toast)

**Interfaces:**
- Consumes: `createSale` (Task 4), `guarded`/`requireStaff`/`requireAdmin` (Task 2).
- Produces: `POST /api/sales` body is now `{ items: {inventoryItemId, quantity}[], paymentMethod, discountAmount, customerId?, expectedTotal }`; errors carry `{ error, code, meta? }`. **Breaking change:** `priceAtSale` and `vatScheme` are no longer accepted from the client.

- [ ] **Step 1: Rewrite the route**

`app/api/sales/route.ts` becomes:

```ts
// app/api/sales/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sales } from '@/lib/db/schema'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createSale } from '@/lib/domain/sales'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    items?: { inventoryItemId: number; quantity: number }[]
    paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
    discountAmount?: number
    customerId?: number
    expectedTotal: number
  }
  const result = await createSale({
    staffId: session.staffId,
    items: body.items ?? [],
    paymentMethod: body.paymentMethod,
    discount: body.discountAmount ?? 0,
    customerId: body.customerId,
    expectedTotal: body.expectedTotal,
  })
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  requireAdmin(await getSession())
  const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(50)
  return NextResponse.json(rows)
})
```

- [ ] **Step 2: Pass expectedTotal through CheckoutDialog**

In `components/pos/CheckoutDialog.tsx` change the prop type and `confirm()`:

```ts
  onConfirm: (paymentMethod: string, discountAmount: number, expectedTotal: number, customerId?: number) => Promise<void>
```

```ts
  async function confirm() {
    setLoading(true)
    await onConfirm(method, discountAmount, total, isStoreCredit && customer ? customer.id : undefined)
    setLoading(false)
    setDiscount('')
    setMethod('cash')
    setCustomer(null)
    setCustomerBalance(null)
  }
```

(`total` is already computed in the component as `subtotal - discountAmount`.)

- [ ] **Step 3: Update the POS page payload and error handling**

In `app/(app)/pos/page.tsx` replace `handleCheckoutConfirm`:

```ts
  async function handleCheckoutConfirm(paymentMethod: string, discountAmount: number, expectedTotal: number, customerId?: number) {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: i.quantity })),
        paymentMethod,
        discountAmount,
        expectedTotal,
        ...(customerId != null ? { customerId } : {}),
      }),
    })
    if (res.ok) {
      const { total } = await res.json()
      setCart([])
      setCheckoutOpen(false)
      toast.success(`Sale complete — ${formatGBP(total)}`)
    } else {
      const data = await res.json().catch(() => null)
      toast.error(
        data?.code === 'PRICE_CHANGED'
          ? 'Prices changed since this search — re-search the cards and rebuild the cart'
          : data?.error ?? 'Sale failed — please try again',
      )
    }
  }
```

- [ ] **Step 4: Verify types and tests**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npm test` — expected: PASS (unchanged).

- [ ] **Step 5: Manual smoke check (dev server)**

Run: `npm run dev`, log in, PIN in, POS: search a card, add to cart, checkout with cash. Expected: "Sale complete" toast; sale visible in Reports recent sales. An item with neither price cache nor override should fail checkout with the NO_PRICE error message.

- [ ] **Step 6: Commit**

```bash
git add app/api/sales/route.ts components/pos/CheckoutDialog.tsx "app/(app)/pos/page.tsx"
git commit -m "feat: server-canonical sale pricing; POS sends quantities and expected total only"
```

---

### Task 6: `createRefund` extraction

**Files:**
- Create: `lib/domain/refunds.ts` (logic moved verbatim from the route)
- Modify: `app/api/refunds/route.ts` (shrinks to parse → auth → call → map)
- Test: `lib/domain/refunds.test.ts`

**Interfaces:**
- Consumes: harness (Task 1), `DomainError`/`guarded`/`requireStaff` (Task 2), `createSale` (Task 4 — used to set up sales in tests).
- Produces:
  ```ts
  interface CreateRefundInput {
    staffId: number
    saleId: number
    method: 'cash' | 'store_credit'
    reason?: string
    items: { saleItemId: number; quantity: number }[]
    customerId?: number
  }
  function createRefund(input: CreateRefundInput, dbc?: Db): Promise<{ refundId: number; amount: number }>
  ```

- [ ] **Step 1: Write the failing tests**

`lib/domain/refunds.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createSale } from './sales'
import { createRefund } from './refunds'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let saleId: number
let saleItemId: number

// Predicates for assert.rejects take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.priceCache).values({ cardId: 1, cardmarketTrend: 10 }) // sell £8.50
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 3, qrCode: 'qr-1',
  })
  // A sale of 3 units with a £5.50 discount: subtotal 25.50, total 20. Ratio 20/25.50.
  const sale = await createSale({
    staffId: 1,
    items: [{ inventoryItemId: 1, quantity: 3 }],
    paymentMethod: 'cash',
    discount: 5.5,
    expectedTotal: 20,
  }, dbc)
  saleId = sale.saleId
  const items = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId))
  saleItemId = items[0].id
})

async function stockOf(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.quantity
}

test('partial refund restocks and reverses the discount proportionally', async () => {
  const { amount } = await createRefund({
    staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }],
  }, dbc)
  // net 8.50 × (20 / 25.50) = 6.666… → 6.67
  assert.equal(amount, 6.67)
  assert.equal(await stockOf(1), 3) // 5 − 3 sold + 1 back
})

test('cannot refund more than remains, across successive refunds', async () => {
  await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 2 }] }, dbc)
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 2 }] }, dbc),
    domainCode('BAD_LINE'),
  )
  // the one remaining unit still refundable
  const { amount } = await createRefund({ staffId: 1, saleId, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc)
  assert.equal(amount, 6.67)
})

test('two lines referencing the same sale item are counted together', async () => {
  await assert.rejects(
    createRefund({
      staffId: 1, saleId, method: 'cash',
      items: [{ saleItemId, quantity: 2 }, { saleItemId, quantity: 2 }], // 4 > 3 sold
    }, dbc),
    domainCode('BAD_LINE'),
  )
  assert.equal(await stockOf(1), 2) // rollback — no restock happened
})

test('store credit refund writes a positive ledger row', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { amount } = await createRefund({
    staffId: 1, saleId, method: 'store_credit', customerId: 1,
    items: [{ saleItemId, quantity: 3 }],
  }, dbc)
  assert.equal(amount, 20) // full refund = full charged total
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 20)
  assert.equal(ledger[0].reason, 'refund')
})

test('validation and not-found errors', async () => {
  await assert.rejects(
    createRefund({ staffId: 1, saleId: 999, method: 'cash', items: [{ saleItemId, quantity: 1 }] }, dbc),
    domainCode('NOT_FOUND'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cheque' as never, items: [{ saleItemId, quantity: 1 }] }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'store_credit', items: [{ saleItemId, quantity: 1 }] }, dbc), // customerId missing
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createRefund({ staffId: 1, saleId, method: 'cash', items: [] }, dbc),
    domainCode('INVALID_INPUT'),
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./refunds`

- [ ] **Step 3: Implement by moving the route logic**

`lib/domain/refunds.ts` — this is the existing logic from `app/api/refunds/route.ts:13-113` with input/validation errors becoming `DomainError`s and `db` becoming the injected handle:

```ts
import { eq, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { sales, saleItems, inventoryItems, refunds, refundItems, creditLedger, customers } from '@/lib/db/schema'
import { DomainError } from './errors'

export interface CreateRefundInput {
  staffId: number
  saleId: number
  method: 'cash' | 'store_credit'
  reason?: string
  items: { saleItemId: number; quantity: number }[]
  customerId?: number
}

const METHODS = new Set(['cash', 'store_credit'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function createRefund(
  input: CreateRefundInput,
  dbc: Db = db,
): Promise<{ refundId: number; amount: number }> {
  if (!Number.isInteger(input.saleId)) throw new DomainError('INVALID_INPUT', 'Invalid saleId')
  if (!METHODS.has(input.method)) throw new DomainError('INVALID_INPUT', 'Invalid method')
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items to refund')
  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    }
  }
  if (input.method === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'customerId required for store credit refunds')
  }

  const [sale] = await dbc.select().from(sales).where(eq(sales.id, input.saleId)).limit(1)
  if (!sale) throw new DomainError('NOT_FOUND', 'Sale not found')

  if (input.method === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const saleItemIds = input.items.map(l => l.saleItemId)
  const originalItems = await dbc.select().from(saleItems).where(inArray(saleItems.id, saleItemIds))
  const byId = new Map(originalItems.map(i => [i.id, i]))

  return dbc.transaction(async (tx) => {
    let netAmount = 0 // pre-discount/VAT amount being refunded, drives proportional reversal
    // Tracks quantity already claimed by earlier lines in *this same request* that reference
    // the same saleItemId — the refundItems rows for those lines aren't inserted until after
    // this loop, so the DB SUM below wouldn't see them without this in-memory tally.
    const claimedThisRequest = new Map<number, number>()

    for (const line of input.items) {
      const original = byId.get(line.saleItemId)
      if (!original || original.saleId !== sale.id) {
        throw new DomainError('BAD_LINE', `Line ${line.saleItemId}: not part of this sale`, { saleItemId: line.saleItemId })
      }

      const [{ refunded }] = await tx.select({
        refunded: sql<number>`COALESCE(SUM(quantity), 0)`,
      }).from(refundItems).where(eq(refundItems.saleItemId, line.saleItemId))

      const alreadyClaimed = claimedThisRequest.get(line.saleItemId) ?? 0
      const remaining = original.quantity - refunded - alreadyClaimed
      if (line.quantity > remaining) {
        throw new DomainError('BAD_LINE', `Line ${line.saleItemId}: only ${remaining} left to refund`, { saleItemId: line.saleItemId, remaining })
      }
      claimedThisRequest.set(line.saleItemId, alreadyClaimed + line.quantity)

      netAmount += original.priceAtSale * line.quantity

      if (original.inventoryItemId) {
        await tx.update(inventoryItems)
          .set({ quantity: sql`quantity + ${line.quantity}` })
          .where(eq(inventoryItems.id, original.inventoryItemId))
      }
    }

    netAmount = round2(netAmount)
    // Reverse VAT/discount proportionally to how this sale's total related to its subtotal,
    // so a partial refund doesn't over- or under-credit versus what was actually charged.
    const chargedRatio = sale.subtotal > 0 ? sale.total / sale.subtotal : 1
    const amount = round2(netAmount * chargedRatio)

    const [refund] = await tx.insert(refunds).values({
      saleId: sale.id,
      staffId: input.staffId,
      method: input.method,
      amount,
      reason: input.reason ?? null,
    }).returning()

    for (const line of input.items) {
      await tx.insert(refundItems).values({
        refundId: refund.id,
        saleItemId: line.saleItemId,
        quantity: line.quantity,
      })
    }

    if (input.method === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: amount,
        reason: 'refund',
        refType: 'sale',
        refId: sale.id,
        staffId: input.staffId,
      })
    }

    return { refundId: refund.id, amount }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Shrink the route**

`app/api/refunds/route.ts` becomes:

```ts
// app/api/refunds/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createRefund } from '@/lib/domain/refunds'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    saleId: number
    method: 'cash' | 'store_credit'
    reason?: string
    items: { saleItemId: number; quantity: number }[]
    customerId?: number
  }
  const result = await createRefund({
    staffId: session.staffId,
    saleId: body.saleId,
    method: body.method,
    reason: body.reason,
    items: body.items ?? [],
    customerId: body.customerId,
  })
  return NextResponse.json(result, { status: 201 })
})
```

Note: error bodies change shape from `{ error: "Line N: detail" }` to `{ error, code, meta }`. Check `components/reports/RefundDialog.tsx` — it reads `data.error` for its toast; that key still exists, so no client change is needed. If it referenced anything else, update it here.

- [ ] **Step 6: Verify types and full suite**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npm test` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/refunds.ts lib/domain/refunds.test.ts app/api/refunds/route.ts
git commit -m "refactor: extract createRefund into tested domain layer"
```

---

### Task 7: `createBuy` extraction

**Files:**
- Create: `lib/domain/buys.ts` (logic moved verbatim from the route)
- Modify: `app/api/buys/route.ts` (shrinks)
- Test: `lib/domain/buys.test.ts`

**Interfaces:**
- Consumes: harness (Task 1), `DomainError`/`guarded`/`requireStaff` (Task 2), existing `generateQRId` from `lib/qr.ts`.
- Produces:
  ```ts
  interface CreateBuyInput {
    staffId: number
    items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
    method: 'cash' | 'store_credit'
    customerId?: number
  }
  function createBuy(input: CreateBuyInput, dbc?: Db): Promise<{ buyId: number; total: number }>
  ```

- [ ] **Step 1: Write the failing tests**

`lib/domain/buys.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createBuy } from './buys'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

// Predicates for assert.rejects take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
})

test('buy creates a new stock row with QR code and records buy items', async () => {
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 4 }],
    method: 'cash',
  }, dbc)
  assert.equal(total, 8)
  const [inv] = await dbc.select().from(schema.inventoryItems)
    .where(and(eq(schema.inventoryItems.cardId, 1), eq(schema.inventoryItems.condition, 'NM')))
  assert.equal(inv.quantity, 2)
  assert.equal(inv.costPrice, 4)
  assert.ok(inv.qrCode.length > 0)
  const items = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(items.length, 1)
  assert.equal(items[0].inventoryItemId, inv.id)
})

test('merge on intake: existing active row gets quantity added and cost blended', async () => {
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 2, costPrice: 3, qrCode: 'qr-1',
  })
  await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'NM', quantity: 2, payPrice: 5 }],
    method: 'cash',
  }, dbc)
  const [inv] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  assert.equal(inv.quantity, 4)
  assert.equal(inv.costPrice, 4) // (3×2 + 5×2) / 4
  const all = await dbc.select().from(schema.inventoryItems)
  assert.equal(all.length, 1) // no duplicate row
})

test('store credit buy writes a positive ledger row', async () => {
  await dbc.insert(schema.customers).values({ id: 1, name: 'Dave' })
  const { buyId, total } = await createBuy({
    staffId: 1,
    items: [{ cardId: 1, condition: 'LP', quantity: 1, payPrice: 6.5 }],
    method: 'store_credit',
    customerId: 1,
  }, dbc)
  assert.equal(total, 6.5)
  const ledger = await dbc.select().from(schema.creditLedger).where(eq(schema.creditLedger.customerId, 1))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 6.5)
  assert.equal(ledger[0].reason, 'buylist')
  assert.equal(ledger[0].refId, buyId)
})

test('validation and not-found errors', async () => {
  const good = { cardId: 1, condition: 'NM', quantity: 1, payPrice: 1 }
  await assert.rejects(
    createBuy({ staffId: 1, items: [], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, condition: 'MINT' }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, quantity: 0 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [{ ...good, payPrice: -1 }], method: 'cash' }, dbc),
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit' }, dbc), // no customer
    domainCode('INVALID_INPUT'),
  )
  await assert.rejects(
    createBuy({ staffId: 1, items: [good], method: 'store_credit', customerId: 99 }, dbc),
    domainCode('NOT_FOUND'),
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./buys`

- [ ] **Step 3: Implement by moving the route logic**

`lib/domain/buys.ts` — existing logic from `app/api/buys/route.ts:13-87`, errors becoming `DomainError`s:

```ts
import { and, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { buyTransactions, buyItems, inventoryItems, creditLedger, customers } from '@/lib/db/schema'
import { generateQRId } from '@/lib/qr'
import { DomainError } from './errors'

export interface CreateBuyInput {
  staffId: number
  items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
  method: 'cash' | 'store_credit'
  customerId?: number
}

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG'])
const round2 = (n: number) => Math.round(n * 100) / 100

export async function createBuy(
  input: CreateBuyInput,
  dbc: Db = db,
): Promise<{ buyId: number; total: number }> {
  if (!input.items?.length) throw new DomainError('INVALID_INPUT', 'No items')
  if (!['cash', 'store_credit'].includes(input.method)) throw new DomainError('INVALID_INPUT', 'Invalid method')
  if (input.method === 'store_credit' && !input.customerId) {
    throw new DomainError('INVALID_INPUT', 'Store credit requires a customer')
  }
  for (const it of input.items) {
    if (!CONDITIONS.has(it.condition)) throw new DomainError('INVALID_INPUT', 'Invalid condition')
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new DomainError('INVALID_INPUT', 'Invalid quantity')
    if (!(it.payPrice >= 0)) throw new DomainError('INVALID_INPUT', 'Invalid pay price')
    if (!Number.isInteger(it.cardId) || it.cardId < 1) throw new DomainError('INVALID_INPUT', 'Invalid cardId')
  }
  const total = round2(input.items.reduce((s, i) => s + round2(i.payPrice) * i.quantity, 0))

  if (input.method === 'store_credit') {
    const [customer] = await dbc.select().from(customers).where(eq(customers.id, input.customerId!)).limit(1)
    if (!customer) throw new DomainError('NOT_FOUND', 'Customer not found')
  }

  const buyId = await dbc.transaction(async (tx) => {
    const [buy] = await tx.insert(buyTransactions).values({
      staffId: input.staffId,
      customerId: input.customerId ?? null,
      method: input.method,
      total,
    }).returning()

    for (const it of input.items) {
      // Merge on intake: increment an existing active row for this card+condition,
      // blending the cost basis; otherwise create a new stock row.
      const [existing] = await tx.select().from(inventoryItems).where(and(
        eq(inventoryItems.cardId, it.cardId),
        eq(inventoryItems.condition, it.condition),
        eq(inventoryItems.isActive, true),
      )).limit(1)

      let inventoryItemId: number
      if (existing) {
        const newQty = existing.quantity + it.quantity
        const newCost = round2((existing.costPrice * existing.quantity + round2(it.payPrice) * it.quantity) / newQty)
        await tx.update(inventoryItems)
          .set({ quantity: newQty, costPrice: newCost })
          .where(eq(inventoryItems.id, existing.id))
        inventoryItemId = existing.id
      } else {
        const [inv] = await tx.insert(inventoryItems).values({
          cardId: it.cardId,
          condition: it.condition,
          quantity: it.quantity,
          costPrice: round2(it.payPrice),
          qrCode: generateQRId(),
        }).returning()
        inventoryItemId = inv.id
      }

      await tx.insert(buyItems).values({
        buyId: buy.id,
        cardId: it.cardId,
        inventoryItemId,
        condition: it.condition,
        quantity: it.quantity,
        payPrice: round2(it.payPrice),
      })
    }

    if (input.method === 'store_credit') {
      await tx.insert(creditLedger).values({
        customerId: input.customerId!,
        delta: total,
        reason: 'buylist',
        refType: 'buy',
        refId: buy.id,
        staffId: input.staffId,
      })
    }
    return buy.id
  })

  return { buyId, total }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Shrink the route**

`app/api/buys/route.ts` becomes:

```ts
// app/api/buys/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { buyTransactions } from '@/lib/db/schema'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { createBuy } from '@/lib/domain/buys'

export const POST = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  const body = await req.json() as {
    items: { cardId: number; condition: string; quantity: number; payPrice: number }[]
    method: 'cash' | 'store_credit'
    customerId?: number
  }
  const result = await createBuy({
    staffId: session.staffId,
    items: body.items ?? [],
    method: body.method,
    customerId: body.customerId,
  })
  return NextResponse.json(result)
})

export const GET = guarded(async () => {
  requireStaff(await getSession())
  const rows = await db.select().from(buyTransactions).orderBy(desc(buyTransactions.createdAt)).limit(50)
  return NextResponse.json(rows)
})
```

- [ ] **Step 6: Verify types and full suite**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npm test` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/buys.ts lib/domain/buys.test.ts app/api/buys/route.ts
git commit -m "refactor: extract createBuy into tested domain layer"
```

---

### Task 8: Adopt auth helpers across all remaining API routes

**Files (modify all):**
- `app/api/cards/[id]/route.ts`, `app/api/cards/search/route.ts`
- `app/api/customers/route.ts`, `app/api/customers/[id]/route.ts`, `app/api/customers/[id]/credit/route.ts`
- `app/api/inventory/route.ts`, `app/api/inventory/[id]/route.ts`, `app/api/inventory/[id]/qr/route.ts`, `app/api/inventory/import/route.ts`, `app/api/inventory/export/route.ts`
- `app/api/prices/cardmarket/route.ts`, `app/api/prices/search/route.ts`
- `app/api/reports/sales/route.ts`, `app/api/reports/sales/export/route.ts`
- `app/api/sales/history/route.ts`, `app/api/sales/[id]/items/route.ts`
- `app/api/settings/route.ts`, `app/api/staff/route.ts`, `app/api/wants/route.ts`

**Interfaces:**
- Consumes: `requireOwner`/`requireStaff`/`requireAdmin` + `guarded` (Task 2).
- Produces: no hand-rolled session checks left anywhere under `app/api/` (the cron route keeps its `CRON_SECRET` bearer check; `app/api/auth/*` routes are the login flows and stay as they are).

Every handler gets the same mechanical treatment — wrap in `guarded(...)`, replace the hand-rolled check with one helper call. There are three existing patterns; convert each occurrence per the mapping below.

**Pattern conversions:**

Pattern 1 — `if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })` becomes:

```ts
export const GET = guarded(async (req: NextRequest) => {
  const session = requireStaff(await getSession())
  // ...rest of handler unchanged (use `session.staffId` where it did before)
})
```

Pattern 2 — `if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) { ...403 }` becomes `requireAdmin(await getSession())`. **This tightens behavior on purpose:** the old check passed for any device-unlocked session (`isOwnerLoggedIn` is true for everyone past the middleware), so admin endpoints were effectively open to all staff. Now they require an admin PIN session. This matches the roles matrix in `docs/superpowers/specs/2026-06-29-pokedb-pos-design.md` §11.

Pattern 3 — `if (!session.isOwnerLoggedIn) return ...401` (also a no-op today) becomes `requireStaff` or `requireAdmin` or `requireOwner` per the target column below.

**Route → helper mapping (every handler):**

| Route file | Handler | Helper | Why |
|---|---|---|---|
| `cards/[id]` | GET | requireStaff | card detail, staff work |
| `cards/search` | GET | requireStaff | POS/buylist search |
| `customers` | GET, POST | requireStaff | counter workflows |
| `customers/[id]` | GET, PATCH | requireStaff | counter workflows |
| `customers/[id]/credit` | POST | requireAdmin | manual credit adjustment (roles matrix: admin) |
| `inventory` | GET | requireStaff | POS search |
| `inventory` | POST | requireStaff | add items (roles matrix: staff may add) |
| `inventory/[id]` | PATCH/PUT | requireStaff | stock adjust (roles matrix: staff) |
| `inventory/[id]` | DELETE | requireAdmin | delete items (roles matrix: admin) |
| `inventory/[id]/qr` | GET | requireStaff | label printing is staff work |
| `inventory/import` | POST | requireAdmin | bulk import (roles matrix: admin) |
| `inventory/export` | GET | requireStaff | keep current level |
| `prices/cardmarket` | GET/POST | requireStaff | price refresh |
| `prices/search` | GET | requireStaff | price lookup |
| `reports/sales` | GET | requireAdmin | full reports (roles matrix: admin) |
| `reports/sales/export` | GET | requireAdmin | same |
| `sales/history` | GET | requireAdmin | same (matches Reports page) |
| `sales/[id]/items` | GET | requireStaff | refund dialog needs it at counter |
| `settings` | GET | requireStaff | POS needs pricing settings |
| `settings` | PUT/PATCH | requireAdmin | config (roles matrix: admin) |
| `staff` | GET | **requireOwner** | PIN pad lists staff *before* any PIN session exists |
| `staff` | POST/PATCH | requireAdmin | manage staff (roles matrix: admin) |
| `wants` | GET, POST, PATCH/DELETE | requireStaff | counter workflows |

Keep each handler's exact HTTP method set as it exists today — the table lists helpers per handler present in the file; if a file has fewer handlers than listed rows, apply only the ones that exist. Do not change any handler body logic beyond the auth line (e.g. `customers/[id]/credit` keeps `staffId: session.staffId ?? null` — after `requireAdmin` you can use `session.staffId` directly).

- [ ] **Step 1: Convert every file listed above**

For each: add `import { guarded } from '@/lib/api'`, extend the `@/lib/auth` import with the needed helpers, wrap each exported handler with `guarded(...)` (converting `export async function GET(...)` declarations to `export const GET = guarded(async (...) => { ... })`), and replace the hand-rolled check with the mapped helper call. Where the old code returned early with a manual 401/403, the helper's thrown `DomainError` now produces the response via `guarded`.

- [ ] **Step 2: Verify no hand-rolled checks remain**

Run: `grep -rn "isOwnerLoggedIn\|staffRole" app/api --include=route.ts | grep -v "app/api/auth/"`
Expected: no output.

Run: `grep -rln "status: 401\|status: 403" app/api --include=route.ts | grep -v "app/api/auth/" | grep -v "app/api/cron/"`
Expected: no output (those statuses now come only from `guarded`).

- [ ] **Step 3: Verify types and tests**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npm test` — expected: PASS.

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`. As a **staff** (non-admin) PIN: POS sale works; Reports API returns 403 (`/api/sales/history`). As an **admin** PIN: Reports page loads. Log out to the PIN screen: the staff list still appears (requireOwner on `staff` GET).

- [ ] **Step 5: Commit**

```bash
git add app/api lib
git commit -m "refactor: uniform requireOwner/requireStaff/requireAdmin across API routes"
```

---

## Post-plan verification (controller, not a task)

- `npm test` and `npx tsc --noEmit` green.
- Manual browser pass: cash sale, store-credit sale (sufficient + insufficient balance), refund partial + over-refund rejection, buy (new card + merge), staff-vs-admin access to Reports.
- Update `.superpowers/sdd/progress-business-ops.md` (or a new ledger file) as tasks complete.
- Then proceed to the Package B plan (integer pence + VAT groundwork).
