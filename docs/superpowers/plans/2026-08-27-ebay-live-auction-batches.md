# eBay Live Auction Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ordered auction batches: pull stock into a numbered batch that hard-holds it from the till, run the stream off a printable run sheet, then settle hammer prices back in — producing one real `ebay_live`-channel sale and returning unsold stock.

**Architecture:** New `auction_batches`/`auction_batch_items` tables plus `inventory_items.held_quantity` and `sales.channel`. Domain module `lib/domain/auction-batches.ts` owns the batch lifecycle; `createSale` gains a held-stock guard; closing a batch atomically writes one sale (channel `ebay_live`, VAT via the existing margin machinery) and releases unsold holds. Reports become explicitly till-scoped and gain a channel split; cash-up stays till-only.

**Tech Stack:** Next.js App Router, Drizzle ORM (libsql/Turso), zod, node:test with `createTestDb`, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-27-ebay-live-auction-batches-design.md` — read it before starting. The plan implements its v1 only: **manual price entry**. CSV import (v1.5) and eBay API (v2) are explicitly out.

## Global Constraints

- **Execution is gated.** The spec's Gates section decides *when* this plan runs. Do not start it because it exists.
- **All money is integer pence.** No floats, no decimal pounds anywhere in domain or DB. Pounds↔pence conversion at the UI edge only.
- **Prices are server-canonical — with the spec's documented carve-out:** hammer prices are operator-entered at settlement. Nothing else about pricing changes; `createSale`'s `expectedTotal` flow is untouched.
- **Every new/changed route:** wrap in `guarded()`, validate with `parseBody(zod)`, call `const db = await getTenantDb()` and pass it to every domain call (never import the `db` singleton in a route — `tests/tenancy-guard.test.ts` enforces).
- **Domain functions** keep `dbc: Db = db` defaults and throw `DomainError(code, message, details?)` from `lib/domain/errors.ts` for expected failures.
- **Client components never value-import** from `lib/domain/` or anything touching `lib/db`. Shared constants go in dependency-free modules (pattern: `lib/adjustment-reasons.ts`).
- **Offline replay compatibility:** `createSale`'s input shape must not change. A queued till sale replaying against newly held stock must get a definitive `DomainError` (parks as conflict), never a hang or shape error.
- **VAT:** check `lib/settings.ts` semantics before touching tax logic; settlement sales use the *same* `computeMarginVat` as till sales.
- **Commits:** always `git add <named files>` — never `git add -A`/`-u`. The working tree carries local-only changes (`vercel.json` Hobby trim, `.claude/skills/grill-me/`) that must NEVER be committed.
- **Tests:** contracts only, colocated `*.test.ts`, node:test + `createTestDb()`/`seedBase()`. No component/render tests. Run `npm test` per task; `npm run lint` before finishing. e2e: extend `tests/e2e/checkout.spec.ts` only (Task 10); in a fresh worktree the first e2e run is a cold-cache throwaway (rerun warm) and worktrees ship empty `node_modules` (`npm ci` first).
- Migration ships with the schema change (Task 1); deploys never auto-migrate — applying it to live DBs is a user-side step *after* merge, per `docs/runbooks/` conventions.

---

### Task 1: Schema + migration 0028

**Files:**
- Modify: `lib/db/schema.ts` (after `stockAdjustments`, schema.ts:233-240; plus `inventoryItems` at :41-61 and `sales` at :88-110)
- Create (generated): `lib/db/migrations/0028_*.sql` via drizzle-kit

**Interfaces:**
- Consumes: existing `staff`, `inventoryItems`, `sales` tables.
- Produces: exported Drizzle tables `auctionBatches`, `auctionBatchItems`; new columns `inventoryItems.heldQuantity` (`held_quantity`, int, notNull, default 0) and `sales.channel` (`channel`, text, notNull, default `'till'`). Every later task imports these exact names from `@/lib/db/schema`.

- [ ] **Step 1: Add the two columns and two tables to `lib/db/schema.ts`**

In `inventoryItems`, after `quantity`:

```ts
  heldQuantity: integer('held_quantity').notNull().default(0),
```

In `sales`, after `paymentMethod`:

```ts
  channel: text('channel').notNull().default('till'), // 'till' | 'ebay_live'
```

After the `stockAdjustments` table:

```ts
// Auction batches: ordered pulls of stock for an eBay Live stream. Creating a
// batch holds stock (inventory_items.held_quantity); closing it writes one
// channel='ebay_live' sale for the sold positions and releases the rest.
export const auctionBatches = sqliteTable('auction_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  status: text('status').notNull().default('open'), // 'open' | 'settled'
  createdByStaffId: integer('created_by_staff_id').notNull().references(() => staff.id),
  saleId: integer('sale_id').references(() => sales.id), // set at close (null if nothing sold)
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  settledAt: text('settled_at'),
})

// One row per physical card, quantity always 1 — position is the auction order
// and the physical numbering. Pulling 2 copies of an item = 2 rows.
export const auctionBatchItems = sqliteTable('auction_batch_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull().references(() => auctionBatches.id),
  inventoryItemId: integer('inventory_item_id').notNull().references(() => inventoryItems.id),
  position: integer('position').notNull(),
  disposition: text('disposition').notNull().default('pending'), // 'pending' | 'sold' | 'unsold' | 'released'
  soldPrice: integer('sold_price'), // pence, post lot-split; set when disposition = 'sold'
  lotKey: integer('lot_key'), // groups rows settled as one lot; null = individual
  releasedByStaffId: integer('released_by_staff_id').references(() => staff.id),
  releasedAt: text('released_at'),
}, (t) => [
  index('idx_auction_batch_items_batch_id').on(t.batchId),
  index('idx_auction_batch_items_inventory_item_id').on(t.inventoryItemId),
])
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `lib/db/migrations/0028_<name>.sql` containing the two `CREATE TABLE`s and the two `ALTER TABLE ... ADD` columns (previous head was `0027_mint-condition.sql`). Read the SQL and confirm exactly that — no drops, no data rewrites.

- [ ] **Step 3: Run the suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS (schema-only change; `createTestDb`'s template picks up migrations).

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations
git commit -m "feat: auction batch tables, held stock and sale channel columns"
```

---

### Task 2: Domain — batch creation, holds, release, reorder

**Files:**
- Create: `lib/domain/auction-batches.ts`
- Create: `lib/domain/auction-batches.test.ts`
- Modify: `lib/domain/errors.ts` (add codes)

**Interfaces:**
- Consumes: `auctionBatches`, `auctionBatchItems`, `inventoryItems` from Task 1; `DomainError`; `Db`/`db` from `@/lib/db`.
- Produces (exact signatures later tasks call):

```ts
export interface BatchItemInput { inventoryItemId: number; count: number }
export async function createAuctionBatch(
  input: { name: string; staffId: number; items?: BatchItemInput[] },
  dbc: Db = db,
): Promise<{ batchId: number }>
export async function addBatchItems(batchId: number, items: BatchItemInput[], dbc: Db = db): Promise<void>
export async function removeBatchItem(batchItemId: number, dbc: Db = db): Promise<void>
export async function releaseBatchItem(batchItemId: number, staffId: number, dbc: Db = db): Promise<void>
export async function reorderBatch(batchId: number, orderedItemIds: number[], dbc: Db = db): Promise<void>
export async function listBatchItems(batchId: number, dbc: Db = db) // rows ordered by position
```

- Error codes added to the code union in `lib/domain/errors.ts`: `ITEM_HELD`, `BATCH_NOT_OPEN`, `BATCH_NOT_DISPOSED`, `BAD_LOT` (open `errors.ts`, extend the existing `DomainError` code type the same way `SALE_VOIDED` is listed; `ITEM_HELD` is used in Task 3, the last two in Task 4).

**Hold semantics (the invariant every test here defends):** `inventory_items.held_quantity` always equals the number of `pending` rows in `open` batches for that item. Sellable = `quantity - held_quantity`. All mutations happen inside one `dbc.transaction` that changes batch rows and `held_quantity` together.

- [ ] **Step 1: Write failing tests**

Create `lib/domain/auction-batches.test.ts` following the exact conventions of `lib/domain/sales.test.ts:1-29`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createAuctionBatch, addBatchItems, removeBatchItem, releaseBatchItem, reorderBatch, listBatchItems } from './auction-batches'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
const domainCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code

async function heldQty(id: number) {
  const [row] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id))
  return row.heldQuantity
}

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc)
  await dbc.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 5, costPrice: 300, sellPriceOverride: 850, qrCode: 'qr-1',
  })
})

test('creating a batch holds stock, one row per physical card', async () => {
  const { batchId } = await createAuctionBatch({ name: 'Friday stream', staffId: 1, items: [{ inventoryItemId: 1, count: 3 }] }, dbc)
  const items = await listBatchItems(batchId, dbc)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((i) => i.position), [1, 2, 3])
  assert.equal(await heldQty(1), 3)
})

test('cannot hold more than sellable stock', async () => {
  const { batchId } = await createAuctionBatch({ name: 'a', staffId: 1, items: [{ inventoryItemId: 1, count: 4 }] }, dbc)
  await assert.rejects(
    addBatchItems(batchId, [{ inventoryItemId: 1, count: 2 }], dbc),
    domainCode('INSUFFICIENT_STOCK'),
  )
  assert.equal(await heldQty(1), 4)
})

test('removing a pending item unholds it; releasing audits who and when', async () => {
  const { batchId } = await createAuctionBatch({ name: 'a', staffId: 1, items: [{ inventoryItemId: 1, count: 2 }] }, dbc)
  const [first, second] = await listBatchItems(batchId, dbc)
  await removeBatchItem(first.id, dbc)
  assert.equal(await heldQty(1), 1)
  await releaseBatchItem(second.id, 1, dbc)
  assert.equal(await heldQty(1), 0)
  const [released] = await dbc.select().from(schema.auctionBatchItems).where(eq(schema.auctionBatchItems.id, second.id))
  assert.equal(released.disposition, 'released')
  assert.equal(released.releasedByStaffId, 1)
  assert.ok(released.releasedAt)
})

test('reorder rewrites positions to the given order', async () => {
  const { batchId } = await createAuctionBatch({ name: 'a', staffId: 1, items: [{ inventoryItemId: 1, count: 3 }] }, dbc)
  const ids = (await listBatchItems(batchId, dbc)).map((i) => i.id)
  await reorderBatch(batchId, [ids[2], ids[0], ids[1]], dbc)
  assert.deepEqual((await listBatchItems(batchId, dbc)).map((i) => i.id), [ids[2], ids[0], ids[1]])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- lib/domain/auction-batches.test.ts` (or `npx tsx --test lib/domain/auction-batches.test.ts` — match whatever `package.json`'s test script does for a single file)
Expected: FAIL — module `./auction-batches` not found.

- [ ] **Step 3: Implement `lib/domain/auction-batches.ts`**

Key mechanics (full file, mirroring `sales.ts` style — guarded conditional UPDATE, no select-then-update):

```ts
import { and, eq, gte, sql, asc, inArray } from 'drizzle-orm'
import { db, type Db } from '../db'
import { auctionBatches, auctionBatchItems, inventoryItems } from '../db/schema'
import { DomainError } from './errors'

export interface BatchItemInput { inventoryItemId: number; count: number }

async function requireOpenBatch(tx: Db, batchId: number) {
  const [batch] = await tx.select().from(auctionBatches).where(eq(auctionBatches.id, batchId)).limit(1)
  if (!batch) throw new DomainError('NOT_FOUND', 'Batch not found')
  if (batch.status !== 'open') throw new DomainError('BATCH_NOT_OPEN', 'Batch is already settled')
  return batch
}

async function holdOne(tx: Db, inventoryItemId: number) {
  // Guarded: held may only grow while sellable (quantity - held) covers it.
  const held = await tx.update(inventoryItems)
    .set({ heldQuantity: sql`held_quantity + 1` })
    .where(and(
      eq(inventoryItems.id, inventoryItemId),
      gte(sql`quantity - held_quantity`, 1),
    ))
    .returning({ id: inventoryItems.id })
  if (held.length === 0) {
    throw new DomainError('INSUFFICIENT_STOCK', `No sellable stock to hold for item ${inventoryItemId}`, { inventoryItemId })
  }
}

async function unholdOne(tx: Db, inventoryItemId: number) {
  await tx.update(inventoryItems)
    .set({ heldQuantity: sql`held_quantity - 1` })
    .where(eq(inventoryItems.id, inventoryItemId))
}

async function appendItems(tx: Db, batchId: number, items: BatchItemInput[]) {
  const [{ maxPos }] = await tx.select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
    .from(auctionBatchItems).where(eq(auctionBatchItems.batchId, batchId))
  let position = maxPos
  for (const item of items) {
    if (item.count < 1) throw new DomainError('INVALID_INPUT', 'count must be >= 1')
    for (let i = 0; i < item.count; i++) {
      await holdOne(tx, item.inventoryItemId)
      position += 1
      await tx.insert(auctionBatchItems).values({ batchId, inventoryItemId: item.inventoryItemId, position })
    }
  }
}

export async function createAuctionBatch(
  input: { name: string; staffId: number; items?: BatchItemInput[] },
  dbc: Db = db,
): Promise<{ batchId: number }> {
  if (!input.name.trim()) throw new DomainError('INVALID_INPUT', 'Batch name required')
  return dbc.transaction(async (tx) => {
    const [batch] = await tx.insert(auctionBatches)
      .values({ name: input.name.trim(), createdByStaffId: input.staffId })
      .returning({ id: auctionBatches.id })
    if (input.items?.length) await appendItems(tx, batch.id, input.items)
    return { batchId: batch.id }
  })
}

export async function addBatchItems(batchId: number, items: BatchItemInput[], dbc: Db = db): Promise<void> {
  await dbc.transaction(async (tx) => {
    await requireOpenBatch(tx, batchId)
    await appendItems(tx, batchId, items)
  })
}

export async function removeBatchItem(batchItemId: number, dbc: Db = db): Promise<void> {
  await dbc.transaction(async (tx) => {
    const [row] = await tx.select().from(auctionBatchItems).where(eq(auctionBatchItems.id, batchItemId)).limit(1)
    if (!row) throw new DomainError('NOT_FOUND', 'Batch item not found')
    await requireOpenBatch(tx, row.batchId)
    if (row.disposition !== 'pending') throw new DomainError('INVALID_INPUT', 'Only pending items can be removed')
    await tx.delete(auctionBatchItems).where(eq(auctionBatchItems.id, batchItemId))
    await unholdOne(tx, row.inventoryItemId)
  })
}

export async function releaseBatchItem(batchItemId: number, staffId: number, dbc: Db = db): Promise<void> {
  await dbc.transaction(async (tx) => {
    const [row] = await tx.select().from(auctionBatchItems).where(eq(auctionBatchItems.id, batchItemId)).limit(1)
    if (!row) throw new DomainError('NOT_FOUND', 'Batch item not found')
    await requireOpenBatch(tx, row.batchId)
    if (row.disposition !== 'pending') throw new DomainError('INVALID_INPUT', 'Only pending items can be released')
    await tx.update(auctionBatchItems)
      .set({ disposition: 'released', releasedByStaffId: staffId, releasedAt: sql`(datetime('now'))` })
      .where(eq(auctionBatchItems.id, batchItemId))
    await unholdOne(tx, row.inventoryItemId)
  })
}

export async function reorderBatch(batchId: number, orderedItemIds: number[], dbc: Db = db): Promise<void> {
  await dbc.transaction(async (tx) => {
    await requireOpenBatch(tx, batchId)
    const rows = await tx.select({ id: auctionBatchItems.id }).from(auctionBatchItems)
      .where(eq(auctionBatchItems.batchId, batchId))
    const existing = new Set(rows.map((r) => r.id))
    if (orderedItemIds.length !== existing.size || orderedItemIds.some((id) => !existing.has(id))) {
      throw new DomainError('INVALID_INPUT', 'Order must list every batch item exactly once')
    }
    for (let i = 0; i < orderedItemIds.length; i++) {
      await tx.update(auctionBatchItems).set({ position: i + 1 }).where(eq(auctionBatchItems.id, orderedItemIds[i]))
    }
  })
}

export async function listBatchItems(batchId: number, dbc: Db = db) {
  return dbc.select().from(auctionBatchItems)
    .where(eq(auctionBatchItems.batchId, batchId))
    .orderBy(asc(auctionBatchItems.position))
}
```

Also add the four new codes to the `DomainError` code union in `lib/domain/errors.ts`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS, including the whole existing suite.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/auction-batches.ts lib/domain/auction-batches.test.ts lib/domain/errors.ts
git commit -m "feat: auction batch domain - create, hold, release, reorder"
```

---

### Task 3: Domain — held stock blocks the till (`ITEM_HELD`)

**Files:**
- Modify: `lib/domain/sales.ts:141-154` (the guarded decrement loop)
- Test: `lib/domain/auction-batches.test.ts` (extend)

**Interfaces:**
- Consumes: `held_quantity` from Task 1; batches from Task 2.
- Produces: `createSale` now throws `DomainError('ITEM_HELD', ..., { inventoryItemId, batches: [{ batchItemId, batchId, name }] })` when a sale exceeds *sellable* but not *physical* stock. Input shape unchanged (offline replay safe).

- [ ] **Step 1: Write failing tests** (append to `auction-batches.test.ts`; import `createSale` from `./sales`)

```ts
test('held stock blocks the till with ITEM_HELD, sellable remainder still sells', async () => {
  await createAuctionBatch({ name: 'Friday stream', staffId: 1, items: [{ inventoryItemId: 1, count: 4 }] }, dbc)
  await assert.rejects(
    createSale({ staffId: 1, items: [{ inventoryItemId: 1, quantity: 2 }], discount: 0, expectedTotal: 1700, paymentMethod: 'cash' }, dbc),
    (e: unknown) => e instanceof DomainError && e.code === 'ITEM_HELD'
      && (e.details as { batches: { name: string }[] }).batches[0].name === 'Friday stream',
  )
  const ok = await createSale({ staffId: 1, items: [{ inventoryItemId: 1, quantity: 1 }], discount: 0, expectedTotal: 850, paymentMethod: 'cash' }, dbc)
  assert.ok(ok.saleId)
})

test('truly insufficient stock still reports INSUFFICIENT_STOCK, not ITEM_HELD', async () => {
  await assert.rejects(
    createSale({ staffId: 1, items: [{ inventoryItemId: 1, quantity: 6 }], discount: 0, expectedTotal: 5100, paymentMethod: 'cash' }, dbc),
    domainCode('INSUFFICIENT_STOCK'),
  )
})
```

(`sellPriceOverride: 850` in the beforeEach seed makes `expectedTotal` deterministic: 850 × qty, `vatScheme` default `'none'`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: first new test FAILS — current guard `gte(inventoryItems.quantity, line.quantity)` ignores holds, so the 2-qty sale *succeeds* (assert.rejects fails).

- [ ] **Step 3: Implement in `sales.ts`**

Replace the decrement guard (sales.ts:141-154) so it subtracts holds, and diagnose the failure:

```ts
    for (const line of lines) {
      const decremented = await tx.update(inventoryItems)
        .set({ quantity: sql`quantity - ${line.quantity}` })
        .where(and(
          eq(inventoryItems.id, line.inventoryItemId),
          gte(sql`quantity - held_quantity`, line.quantity),
        ))
        .returning({ id: inventoryItems.id })
      if (decremented.length === 0) {
        const [item] = await tx.select({ quantity: inventoryItems.quantity, heldQuantity: inventoryItems.heldQuantity })
          .from(inventoryItems).where(eq(inventoryItems.id, line.inventoryItemId)).limit(1)
        if (item && item.heldQuantity > 0 && item.quantity >= line.quantity) {
          const batches = await tx.select({ batchItemId: auctionBatchItems.id, batchId: auctionBatches.id, name: auctionBatches.name })
            .from(auctionBatchItems)
            .innerJoin(auctionBatches, eq(auctionBatchItems.batchId, auctionBatches.id))
            .where(and(
              eq(auctionBatchItems.inventoryItemId, line.inventoryItemId),
              eq(auctionBatchItems.disposition, 'pending'),
              eq(auctionBatches.status, 'open'),
            ))
          throw new DomainError('ITEM_HELD', `Item ${line.inventoryItemId} is held for an auction batch`, { inventoryItemId: line.inventoryItemId, batches })
        }
        throw new DomainError('INSUFFICIENT_STOCK', `Insufficient stock for item ${line.inventoryItemId}`, { inventoryItemId: line.inventoryItemId })
      }
    }
```

(add `auctionBatches`, `auctionBatchItems` to the schema imports in `sales.ts`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS — including every pre-existing `sales.test.ts` case (their items have `held_quantity = 0`, so behavior is identical).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/sales.ts lib/domain/auction-batches.test.ts
git commit -m "feat: createSale blocks auction-held stock with ITEM_HELD"
```

---

### Task 4: Domain — settlement and close

**Files:**
- Create: `lib/lot-split.ts` (dependency-free — client components import it too, same rule as `lib/adjustment-reasons.ts`)
- Modify: `lib/domain/auction-batches.ts`
- Test: `lib/domain/auction-batches.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 module; `computeMarginVat` from `@/lib/pricing`; `getSettings` from `@/lib/settings` (mirror exactly how `createSale` in `sales.ts:106-117` loads settings and builds margin lines — read that block first and copy its shapes); `sales`, `saleItems`, `salePayments` schema tables (mirror `createSale`'s inserts at sales.ts:170-201).
- Produces:

```ts
export type SettlementEntry =
  | { kind: 'lot'; batchItemIds: number[]; pricePence: number } // 1 id = individual sale
  | { kind: 'no_sale'; batchItemId: number }
export async function settlePositions(batchId: number, staffId: number, entries: SettlementEntry[], dbc: Db = db): Promise<void>
export async function closeAuctionBatch(batchId: number, staffId: number, dbc: Db = db): Promise<{ saleId: number | null; marginNoCostCount: number }>
// in lib/lot-split.ts (NOT lib/domain/ — the settlement UI imports it for previews):
export function splitLotPrice(totalPence: number, count: number): number[]
```

**Money rules being implemented:** gross hammer per row; lot prices split largest-remainder in integer pence (earlier positions get the extra pence); the close writes ONE sale: `channel='ebay_live'`, `paymentMethod='other'`, one `sale_payments` row (`method: 'other'`, amount = total), one `sale_items` row per sold batch row (`quantity: 1`, `priceAtSale: soldPrice`, `costAtSale` snapshotted from `inventory_items.costPrice`), VAT via `computeMarginVat(lines, 0)` when `settings.vatScheme === 'margin'` (same helper as the till). **Deliberate difference from the till:** `marginNoCostHandling === 'block'` must NOT block a close (the auction already happened; blocking would strand physical stock) — always use exclude-and-warn semantics and return `marginNoCostCount`.

- [ ] **Step 1: Write failing tests**

```ts
import { settlePositions, closeAuctionBatch } from './auction-batches'
import { splitLotPrice } from '../lot-split'
import { createRefund } from './refunds'
import { updateSettings } from '../settings'
import { computeMarginVat } from '../pricing'

test('lot prices split pence-exact by largest remainder', () => {
  assert.deepEqual(splitLotPrice(2501, 2), [1251, 1250])
  assert.deepEqual(splitLotPrice(1000, 3), [334, 333, 333])
  assert.equal(splitLotPrice(999, 7).reduce((a, b) => a + b, 0), 999)
})

test('close writes one ebay_live sale at hammer prices and returns unsold stock', async () => {
  const { batchId } = await createAuctionBatch({ name: 's', staffId: 1, items: [{ inventoryItemId: 1, count: 3 }] }, dbc)
  const items = await listBatchItems(batchId, dbc)
  await settlePositions(batchId, 1, [
    { kind: 'lot', batchItemIds: [items[0].id, items[1].id], pricePence: 2501 },
    { kind: 'no_sale', batchItemId: items[2].id },
  ], dbc)
  const { saleId } = await closeAuctionBatch(batchId, 1, dbc)
  assert.ok(saleId)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId!))
  assert.equal(sale.channel, 'ebay_live')
  assert.equal(sale.paymentMethod, 'other')
  assert.equal(sale.total, 2501)
  const soldLines = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId!))
  assert.deepEqual(soldLines.map((l) => l.priceAtSale).sort((a, b) => b - a), [1251, 1250])
  assert.deepEqual(soldLines.map((l) => l.costAtSale), [300, 300])
  const [item] = await dbc.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, 1))
  assert.equal(item.quantity, 3)      // 5 physical − 2 sold
  assert.equal(item.heldQuantity, 0)  // unsold returned to sellable
})

test('close applies the till margin-VAT computation', async () => {
  await updateSettings({ vatScheme: 'margin' }, dbc)
  const { batchId } = await createAuctionBatch({ name: 'm', staffId: 1, items: [{ inventoryItemId: 1, count: 2 }] }, dbc)
  const items = await listBatchItems(batchId, dbc)
  await settlePositions(batchId, 1, [{ kind: 'lot', batchItemIds: [items[0].id, items[1].id], pricePence: 2501 }], dbc)
  const { saleId } = await closeAuctionBatch(batchId, 1, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId!))
  assert.equal(sale.vatScheme, 'margin')
  const expected = computeMarginVat(
    [1251, 1250].map((p) => ({ priceAtSale: p, quantity: 1, costAtSale: 300 })) as never,
    0,
  ).vatAmount
  assert.equal(sale.vatAmount, expected)
})

test('close refuses while positions are pending, and refuses twice', async () => {
  const { batchId } = await createAuctionBatch({ name: 'p', staffId: 1, items: [{ inventoryItemId: 1, count: 1 }] }, dbc)
  await assert.rejects(closeAuctionBatch(batchId, 1, dbc), domainCode('BATCH_NOT_DISPOSED'))
  const [item] = await listBatchItems(batchId, dbc)
  await settlePositions(batchId, 1, [{ kind: 'no_sale', batchItemId: item.id }], dbc)
  const { saleId } = await closeAuctionBatch(batchId, 1, dbc)
  assert.equal(saleId, null) // nothing sold — no sale row written
  await assert.rejects(closeAuctionBatch(batchId, 1, dbc), domainCode('BATCH_NOT_OPEN'))
})

test('settlement entries are re-editable before close', async () => {
  const { batchId } = await createAuctionBatch({ name: 'e', staffId: 1, items: [{ inventoryItemId: 1, count: 1 }] }, dbc)
  const [item] = await listBatchItems(batchId, dbc)
  await settlePositions(batchId, 1, [{ kind: 'lot', batchItemIds: [item.id], pricePence: 100 }], dbc)
  await settlePositions(batchId, 1, [{ kind: 'lot', batchItemIds: [item.id], pricePence: 2200 }], dbc)
  const { saleId } = await closeAuctionBatch(batchId, 1, dbc)
  const [sale] = await dbc.select().from(schema.sales).where(eq(schema.sales.id, saleId!))
  assert.equal(sale.total, 2200)
})
```

Note on the margin test: before writing it, open `lib/pricing.ts` and use `computeMarginVat`'s real line type in place of the `as never` sketch — the assertion is the contract (settlement VAT === till helper's answer for the same lines), the cast is not.

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `settlePositions`/`closeAuctionBatch`/`splitLotPrice` not exported.

- [ ] **Step 3: Implement in `lib/domain/auction-batches.ts`**

Create `lib/lot-split.ts` (dependency-free; plain `RangeError`, never `DomainError` — importing `lib/domain/errors` here would let client bundles reach into `lib/domain/`):

```ts
// Split one lot price across N cards, pence-exact: earlier positions carry the
// extra pennies. Dependency-free — client components import this for previews.
export function splitLotPrice(totalPence: number, count: number): number[] {
  if (count < 1 || !Number.isInteger(totalPence) || totalPence < 0) {
    throw new RangeError('splitLotPrice needs non-negative integer pence and count >= 1')
  }
  const base = Math.floor(totalPence / count)
  const remainder = totalPence - base * count
  return Array.from({ length: count }, (_, i) => (i < remainder ? base + 1 : base))
}
```

Then in `lib/domain/auction-batches.ts` (`import { splitLotPrice } from '../lot-split'`); `settlePositions` validates `entry.pricePence` with `DomainError('BAD_LOT', ...)` *before* calling it:

```ts
export type SettlementEntry =
  | { kind: 'lot'; batchItemIds: number[]; pricePence: number }
  | { kind: 'no_sale'; batchItemId: number }

export async function settlePositions(batchId: number, staffId: number, entries: SettlementEntry[], dbc: Db = db): Promise<void> {
  await dbc.transaction(async (tx) => {
    await requireOpenBatch(tx, batchId)
    const rows = await tx.select().from(auctionBatchItems).where(eq(auctionBatchItems.batchId, batchId))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const touched = new Set<number>()
    const claim = (id: number) => {
      const row = byId.get(id)
      if (!row) throw new DomainError('BAD_LOT', `Batch item ${id} is not in this batch`)
      if (row.disposition === 'released') throw new DomainError('BAD_LOT', `Batch item ${id} was released`)
      if (touched.has(id)) throw new DomainError('BAD_LOT', `Batch item ${id} appears twice`)
      touched.add(id)
      return row
    }
    let lotKey = rows.reduce((m, r) => Math.max(m, r.lotKey ?? 0), 0)
    for (const entry of entries) {
      if (entry.kind === 'no_sale') {
        claim(entry.batchItemId)
        await tx.update(auctionBatchItems)
          .set({ disposition: 'unsold', soldPrice: null, lotKey: null })
          .where(eq(auctionBatchItems.id, entry.batchItemId))
        continue
      }
      if (entry.batchItemIds.length === 0) throw new DomainError('BAD_LOT', 'Lot has no items')
      if (!Number.isInteger(entry.pricePence) || entry.pricePence < 0) {
        throw new DomainError('BAD_LOT', 'Lot price must be non-negative integer pence')
      }
      entry.batchItemIds.forEach(claim)
      const prices = splitLotPrice(entry.pricePence, entry.batchItemIds.length)
      lotKey += 1
      const isLot = entry.batchItemIds.length > 1
      for (let i = 0; i < entry.batchItemIds.length; i++) {
        await tx.update(auctionBatchItems)
          .set({ disposition: 'sold', soldPrice: prices[i], lotKey: isLot ? lotKey : null })
          .where(eq(auctionBatchItems.id, entry.batchItemIds[i]))
      }
    }
  })
}
```

`closeAuctionBatch` — the atomic settle:

```ts
export async function closeAuctionBatch(batchId: number, staffId: number, dbc: Db = db): Promise<{ saleId: number | null; marginNoCostCount: number }> {
  return dbc.transaction(async (tx) => {
    // Idempotency guard: flip open→settled first; second close finds it settled.
    const flipped = await tx.update(auctionBatches)
      .set({ status: 'settled', settledAt: sql`(datetime('now'))` })
      .where(and(eq(auctionBatches.id, batchId), eq(auctionBatches.status, 'open')))
      .returning({ id: auctionBatches.id })
    if (flipped.length === 0) {
      const [batch] = await tx.select().from(auctionBatches).where(eq(auctionBatches.id, batchId)).limit(1)
      if (!batch) throw new DomainError('NOT_FOUND', 'Batch not found')
      throw new DomainError('BATCH_NOT_OPEN', 'Batch is already settled')
    }
    const rows = await tx.select().from(auctionBatchItems)
      .where(eq(auctionBatchItems.batchId, batchId)).orderBy(asc(auctionBatchItems.position))
    if (rows.some((r) => r.disposition === 'pending')) {
      throw new DomainError('BATCH_NOT_DISPOSED', 'Every position must be sold, no-sale, or released before closing')
    }
    const sold = rows.filter((r) => r.disposition === 'sold')
    const unsold = rows.filter((r) => r.disposition === 'unsold')
    for (const row of unsold) await unholdOne(tx, row.inventoryItemId)
    if (sold.length === 0) return { saleId: null, marginNoCostCount: 0 }

    // Sold stock leaves the building: quantity and held drop together, guarded.
    for (const row of sold) {
      const dec = await tx.update(inventoryItems)
        .set({ quantity: sql`quantity - 1`, heldQuantity: sql`held_quantity - 1` })
        .where(and(eq(inventoryItems.id, row.inventoryItemId), gte(inventoryItems.quantity, 1), gte(inventoryItems.heldQuantity, 1)))
        .returning({ id: inventoryItems.id })
      if (dec.length === 0) throw new DomainError('INSUFFICIENT_STOCK', `Hold invariant broken for item ${row.inventoryItemId}`, { inventoryItemId: row.inventoryItemId })
    }
    // Cost snapshots + VAT: mirror createSale (sales.ts:106-117, 170-201) exactly —
    // same settings load, same computeMarginVat call shape, same insert columns.
    // marginNoCostHandling 'block' is deliberately NOT applied here (spec: the
    // auction already happened) — always exclude-and-warn.
    // ... build lines { priceAtSale: row.soldPrice, quantity: 1, costAtSale } from
    // inventory costPrice; subtotal = sum; vatAmount/vatScheme per settings;
    // insert into sales { staffId, subtotal, discountAmount: 0, vatAmount, vatScheme,
    // total: subtotal, paymentMethod: 'other', channel: 'ebay_live' }, then one
    // saleItems row per sold batch row, then one salePayments row
    // { saleId, method: 'other', amount: total } — copy the exact column set from
    // createSale's inserts rather than inventing one.
    await tx.update(auctionBatches).set({ saleId }).where(eq(auctionBatches.id, batchId))
    return { saleId, marginNoCostCount }
  })
}
```

The elided block is deliberate in the *plan* only because its authoritative source is `createSale`'s own insert code — the implementing engineer copies those lines (sales.ts:106-117 for VAT, 170-201 for the three inserts), adjusting exactly: `channel: 'ebay_live'`, `paymentMethod: 'other'`, `discountAmount: 0`, no customer, no credit ledger, no expectedTotal check. Do not re-derive the VAT math; call `computeMarginVat` with the same line shape `createSale` builds.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lot-split.ts lib/domain/auction-batches.ts lib/domain/auction-batches.test.ts
git commit -m "feat: auction settlement - lot splits, atomic close to an ebay_live sale"
```

---

### Task 5: Refunds reject `ebay_live` sales

**Files:**
- Modify: `lib/domain/refunds.ts:33-35` (after the `voidedAt` guard), `lib/domain/errors.ts` (add `WRONG_CHANNEL`)
- Test: `lib/domain/auction-batches.test.ts` (extend)

**Interfaces:**
- Produces: `createRefund` throws `DomainError('WRONG_CHANNEL', ...)` for non-`till` sales. Void is deliberately left working (admin correction path for a mis-entered settlement: void → stock returns → rebuild batch → resettle).

- [ ] **Step 1: Write the failing test**

```ts
test('refunds are rejected for ebay_live sales', async () => {
  const { batchId } = await createAuctionBatch({ name: 'r', staffId: 1, items: [{ inventoryItemId: 1, count: 1 }] }, dbc)
  const [item] = await listBatchItems(batchId, dbc)
  await settlePositions(batchId, 1, [{ kind: 'lot', batchItemIds: [item.id], pricePence: 2200 }], dbc)
  const { saleId } = await closeAuctionBatch(batchId, 1, dbc)
  const [line] = await dbc.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, saleId!))
  await assert.rejects(
    createRefund({ staffId: 1, saleId: saleId!, method: 'cash', items: [{ saleItemId: line.id, quantity: 1 }] }, dbc),
    domainCode('WRONG_CHANNEL'),
  )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — refund currently succeeds (or fails with a different code).

- [ ] **Step 3: Implement**

In `refunds.ts`, directly after `if (sale.voidedAt) throw ...` (line 35):

```ts
  if (sale.channel !== 'till') {
    throw new DomainError('WRONG_CHANNEL', 'This sale was settled off-till (eBay Live) — money never entered the till. Handle returns as a manual restock.')
  }
```

Add `WRONG_CHANNEL` to the code union in `errors.ts`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/refunds.ts lib/domain/errors.ts lib/domain/auction-batches.test.ts
git commit -m "feat: refunds reject off-till (ebay_live) sales"
```

---

### Task 6: API routes

**Files:**
- Create: `app/api/auction-batches/route.ts` (GET list, POST create)
- Create: `app/api/auction-batches/[id]/route.ts` (GET detail with card names)
- Create: `app/api/auction-batches/[id]/items/route.ts` (POST add, PATCH reorder)
- Create: `app/api/auction-batches/items/[itemId]/route.ts` (DELETE remove, POST release — release body `{ action: 'release' }`)
- Create: `app/api/auction-batches/[id]/settle/route.ts` (POST entries)
- Create: `app/api/auction-batches/[id]/close/route.ts` (POST)
- Modify: `app/api/inventory/route.ts` (GET: include `heldQuantity`; for `qrCode` lookups also `heldBatches: { batchItemId, batchId, name }[]` from pending rows in open batches)

**Interfaces:**
- Consumes: every exported domain function from Tasks 2/4, called with the tenant `db`.
- Produces: the endpoints the Task 8/9 UI fetches. All follow the house convention verbatim (model: `app/api/refunds/route.ts`): `guarded()` wrapper → `getTenantDb()` → `requireTransactingStaff(await getSession(await currentTenantId()))` → `parseBody(req, schema)` → domain call → `NextResponse.json`.

- [ ] **Step 1: Implement the routes**

Zod bodies (exact):

```ts
const createBatchBody = z.object({
  name: z.string().min(1),
  items: z.array(z.object({ inventoryItemId: z.number().int(), count: z.number().int().min(1) })).default([]),
})
const addItemsBody = z.object({
  items: z.array(z.object({ inventoryItemId: z.number().int(), count: z.number().int().min(1) })).min(1),
})
const reorderBody = z.object({ orderedItemIds: z.array(z.number().int()).min(1) })
const settleBody = z.object({
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lot'), batchItemIds: z.array(z.number().int()).min(1), pricePence: z.number().int().min(0) }),
    z.object({ kind: z.literal('no_sale'), batchItemId: z.number().int() }),
  ])).min(1),
})
```

The detail GET joins batch items → `inventoryItems` → `cards` (name/set) and `products` (name) so the UI and run sheet can render "position, name, set, condition" without further fetches; look at how `app/api/inventory/route.ts` GET already shapes card+product names for its results and reuse that select shape. Staff-gating: `requireTransactingStaff` everywhere (settlement is money-entry equivalent to a till sale; same gate as refunds).

- [ ] **Step 2: Run the suite (tenancy guard is the test)**

Run: `npm test && npm run lint`
Expected: PASS — `tests/tenancy-guard.test.ts` fails loudly if any new route imports the `db` singleton; lint clean. (No per-route unit tests — house norm: contracts live in domain tests.)

- [ ] **Step 3: Commit**

```bash
git add app/api/auction-batches app/api/inventory/route.ts
git commit -m "feat: auction batch API routes, held info on inventory lookups"
```

---

### Task 7: Reports — channel split, till-scoping, cash-up

**Files:**
- Modify: `lib/domain/reports.ts` — add `eq(sales.channel, 'till')` to the sale-scoped WHEREs of `getCashUpSummary` (every `sales`-joined aggregate inside it, incl. the verbatim block at reports.ts:40-51), `getSalesByStaff`, `getMarginByStaff`, `getSalesByPaymentMethod`, `getSalesByCategory`; add new `getSalesByChannel`; extend `getMarginStockBook` to include **all** channels with a `channel` column (it is the HMRC record — the one deliberate both-channels surface).
- Modify: `app/api/reports/sales/route.ts` (call + return `byChannel`), `app/api/reports/sales/export/route.ts` (add `channel` column to the CSV), `app/api/sales/history/route.ts` (today-tiles query gains `eq(sales.channel, 'till')`), `app/api/sales/search/route.ts` / `lib/domain/sales-search.ts` (include `channel` in results so the returns desk sees why refund is blocked).
- Test: `lib/domain/reports.test.ts` (extend — or create following the same conventions if reports has no test file yet; check first).

**Interfaces:**
- Produces:

```ts
export async function getSalesByChannel(from: string, to: string, dbc: Db = db):
  Promise<{ channel: string; total: number; count: number }[]>
```

  (same `[from 00:00:00, to+1day)` window + `isNull(sales.voidedAt)` pattern as its siblings in `reports.ts` — copy the exact date handling from `getSalesByStaff`.)

**Rule being implemented (spec):** every existing sale aggregate becomes explicitly till-scoped; ONE new channel split shows both; cash-up is till-only; the margin stock book includes both channels because it is the legal record.

- [ ] **Step 1: Write failing tests**

In the reports test file (create with the standard header if absent), seed: one till cash sale (use `createSale` exactly as `sales.test.ts` does — item with `sellPriceOverride: 850`, `expectedTotal: 850`) and one settled batch (`createAuctionBatch` → `settlePositions` lot 2501 → `closeAuctionBatch`), then:

```ts
test('channel split separates till from ebay_live; till aggregates exclude auctions', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const byChannel = await getSalesByChannel(today, today, dbc)
  assert.deepEqual(
    byChannel.sort((a, b) => a.channel.localeCompare(b.channel)),
    [{ channel: 'ebay_live', total: 2501, count: 1 }, { channel: 'till', total: 850, count: 1 }],
  )
  const byMethod = await getSalesByPaymentMethod(today, today, dbc)
  assert.equal(byMethod.reduce((s, r) => s + r.total, 0), 850) // auction's 2501 absent
})

test('cash-up counts only till cash', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const summary = await getCashUpSummary(today, dbc)
  // Read getCashUpSummary's return type and assert on its cash-from-sales field
  // (the figure built from the salePayments/cash query at reports.ts:40-51):
  // it must equal 850 — the ebay_live sale contributes nothing.
})
```

Before running, replace the comment in the second test with the real field assertion — open `getCashUpSummary`'s return object in `reports.ts` and use its actual property name (the sum aliased `total` from the cash query feeds it). Match `getSalesByPaymentMethod`'s real signature/row shape the same way (adjust property names to what the function actually returns — the *contract* is: 850 present, 2501 absent).

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `getSalesByChannel` doesn't exist; existing aggregates currently include the 2501.

- [ ] **Step 3: Implement**

`getSalesByChannel` (copy the window handling verbatim from a sibling):

```ts
export async function getSalesByChannel(from: string, to: string, dbc: Db = db) {
  const fromTs = `${from} 00:00:00`
  const toExcl = sql<string>`datetime(${to}, '+1 day')`
  return dbc.select({
    channel: sales.channel,
    total: sql<number>`COALESCE(SUM(${sales.total}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(sales)
    .where(and(isNull(sales.voidedAt), gte(sales.createdAt, fromTs), lt(sales.createdAt, toExcl)))
    .groupBy(sales.channel)
}
```

Then mechanically add `eq(sales.channel, 'till')` inside the existing `and(...)`s listed above, `channel` to the two CSVs and the search result select, and wire `byChannel` through `app/api/reports/sales/route.ts`'s response object.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS — including any pre-existing reports tests (they only ever created till sales, so till-scoping changes nothing for them).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/reports.ts lib/domain/reports.test.ts lib/domain/sales-search.ts app/api/reports app/api/sales/history/route.ts app/api/sales/search/route.ts
git commit -m "feat: sales channel split - till-scoped reports, till-only cash-up"
```

---

### Task 8: UI — Auctions page, run sheet, settlement

**Files:**
- Create: `app/(app)/auctions/page.tsx` (client page: batch list + create + detail)
- Create: `components/auctions/BatchDetail.tsx`, `components/auctions/SettlementPanel.tsx`
- Create: `lib/run-sheet-html.ts` (dependency-free HTML renderer — MUST NOT import anything touching `lib/db`, same rule and header comment as `lib/receipt-html.ts`)
- Modify: `components/layout/Nav.tsx` (add "Auctions" link, matching the existing link array + icon style; labels are `hidden lg:inline` per the tablet pass — follow it)
- Modify: `app/(app)/reports/page.tsx` (render the `byChannel` section: one line per channel, the eBay line labelled exactly **"eBay Live (hammer totals, excl. postage)"** — the spec's required wording)

**Interfaces:**
- Consumes: Task 6 endpoints; `SearchBar` from `components/pos/SearchBar.tsx` (reused as-is for scan/search-into-batch — it already exposes `onSearch`/`onQRDetected`); the popup-print pattern from `ReceiptDialog.tsx:44-54`.
- Produces: `runSheetHtml(batch: { name: string; createdAt: string; items: { position: number; name: string; setName: string | null; condition: string }[] }): string`.

Behaviors (v1, deliberately spartan):
- **List**: open batches first (status chip), settled below with sale link/total.
- **Detail (open)**: ordered rows `position · name · set · condition`; add via `SearchBar` (scan → `POST items`); per-row remove; ↑/↓ buttons calling `PATCH` reorder with the full id order (no drag-and-drop in v1); **Print run sheet** button using the `window.open` + `document.write(runSheetHtml(...))` + `win.print()` pattern copied from `ReceiptDialog`; **Settle** switches to `SettlementPanel`.
- **SettlementPanel**: rows in position order; per row a pounds price input (converted to pence at the edge: `Math.round(parseFloat(v) * 100)`, rejecting NaN/negative) and a "No sale" toggle; **lot mode**: checkboxes select N rows → one price input → client shows the split preview via `splitLotPrice` imported from `lib/lot-split.ts` (dependency-free, created in Task 4 — never import from `lib/domain/`); Save posts `entries` (server split is authoritative); **Close batch** button posts close, surfaces `BATCH_NOT_DISPOSED` by highlighting unpriced rows, and on success shows total + `marginNoCostCount` warning if > 0.
- **Run sheet**: A4-ish table — batch name, date, then `# / Card / Set / Cond / Hammer £ ____` rows (blank hammer column is the point: it's filled by pen during the stream).

- [ ] **Step 1: Implement** (no component tests — house policy; the compile + lint + Task 10's e2e are the net)

- [ ] **Step 2: Verify in the browser**

Run the dev server via the Browser pane (launch.json config), against the local sandbox DB (`.env.local` — see memory/AGENTS conventions): create a batch, scan/add, reorder, print preview the run sheet, settle a lot of 2 (odd pence total — check the preview split), close, confirm the reports page shows the "eBay Live (hammer totals, excl. postage)" line and the sale appears in history with its channel.
Expected: full loop works; console free of errors.

- [ ] **Step 3: Lint + suite**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/auctions components/auctions lib/run-sheet-html.ts components/layout/Nav.tsx app/\(app\)/reports/page.tsx
git commit -m "feat: auctions page - batch building, run sheet, settlement"
```

---

### Task 9: UI — POS block-with-release + inventory badge

**Files:**
- Create: `components/pos/HeldItemDialog.tsx`
- Modify: `app/(app)/pos/page.tsx` (`handleQRDetected`/`handleAddToCart` paths), `components/pos/CardResult.tsx` (held indicator), `components/inventory/InventoryTable.tsx` (held badge column: show `heldQuantity` when > 0, e.g. "2 held")

**Interfaces:**
- Consumes: `heldQuantity` + `heldBatches` from the Task 6 inventory GET; release endpoint `POST /api/auction-batches/items/[itemId]` with `{ action: 'release' }`.

Behavior: when an add-to-cart would exceed `quantity - heldQuantity`, open `HeldItemDialog` — text: **"Held for auction batch "<name>" — release it?"**, buttons **Release & add** (POST release for one pending `batchItemId` from `heldBatches`, then re-run the add) and **Cancel**. Style/structure copied from `CheckoutDialog.tsx` (the existing modal pattern). The dialog is UX; `createSale`'s `ITEM_HELD` (Task 3) remains the authority — if checkout still hits it (second till raced), surface the error toast with the batch name from `details.batches[0].name`, same toast style the POS uses for `INSUFFICIENT_STOCK` today.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Verify in the browser**

With a batch holding all copies of an item: scan it at the POS → dialog appears with the batch name → Cancel leaves cart unchanged → scan again → Release & add puts it in the cart and checkout completes. Inventory page shows the held badge on a held item.
Expected: works; the released row shows disposition `released` on the batch detail.

- [ ] **Step 3: Lint + suite, commit**

Run: `npm test && npm run lint` → PASS, then:

```bash
git add components/pos/HeldItemDialog.tsx components/pos/CardResult.tsx app/\(app\)/pos/page.tsx components/inventory/InventoryTable.tsx
git commit -m "feat: POS block-with-release for auction-held stock, inventory held badge"
```

---

### Task 10: e2e — extend the checkout smoke

**Files:**
- Modify: `tests/e2e/checkout.spec.ts` (new `test(...)` block in the same file — house rule: extend, never add per-feature spec files)

**Interfaces:**
- Consumes: the seeded card/product from `tests/e2e/seed.ts` (read it first for the exact seeded names/qr codes) and the login flow already scripted in the existing test (owner unlock → PIN → `/pos`).

- [ ] **Step 1: Add the test**

Shape (adapt selectors to the real page markup you just built — read the existing test's selector style and copy it):

```ts
test('auction-held stock blocks the till until released', async ({ page }) => {
  // login + PIN exactly as the existing test does
  // 1. /auctions: create batch "E2E stream", scan/search the seeded card in, expect it listed at position 1
  // 2. /pos: scan the same card's QR → expect dialog text /Held for auction batch/ and /E2E stream/
  // 3. Cancel → cart still empty
  // 4. Scan again → click "Release & add" → item in cart → cash checkout completes (reuse the existing test's tender steps)
  // 5. DB assert via createClient(E2E_DB_PATH) as the existing test does: the batch item row has disposition 'released', and inventory quantity decremented by the sale
})
```

Every commented line becomes real Playwright code against the selectors from Tasks 8/9 — the comments are the required behaviors, not optional ones.

- [ ] **Step 2: Run it warm**

Run: `npm run test:e2e` (twice if this is a fresh worktree — first run is the cold-cache throwaway)
Expected: full e2e set PASS including the new test.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/checkout.spec.ts
git commit -m "test: e2e - held stock blocks checkout until released"
```

---

### Task 11: Architecture map + final verification

**Files:**
- Modify: `docs/architecture/map.json` (via the `architecture-map` skill)

- [ ] **Step 1: Update the map**

Invoke the `architecture-map` skill (it owns the format) to add the auction-batch flow: new nodes for `lib/domain/auction-batches.ts` and the `app/api/auction-batches/*` routes, edges into `sales`/till (the `ITEM_HELD` guard in `createSale`), money-out/reports (channel filter in `reports.ts`), placed in the till + money-out areas (or a new part if the skill's conventions say so). If the skill is unavailable in the executing session, edit `map.json` by hand keeping the seven structural checks in `scripts/architecture-map.test.ts` green (every named file exists, ids resolve, nodes placed + indexed, edges' ends share an area).

- [ ] **Step 2: Full verification**

Run: `npm test && npm run lint && npm run test:e2e`
Expected: all PASS. This is the evidence for the finishing-a-development-branch step; do not claim done without it.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/map.json
git commit -m "docs: map the auction batch flow"
```

---

## Post-merge (user-side, NOT part of this plan's execution)

- Apply migration 0028 to the live dev/tenant DB(s) per the standing deploy contract (deploys never auto-migrate; `scripts/migrate-tenants.ts` once a live registry exists).
- The independent `sold-elsewhere` adjustment-reason probe is already built as **draft PR #63** (2026-08-27; no migration; merge held to the week of 2026-08-31). No ordering dependency with this plan — when it lands, `ADJUSTMENT_REASONS` contains `'sold-elsewhere'` and its per-reason adjustments table in the range summary is where the demand telemetry for this plan's build gate is read.

## Deliberate v1 exclusions (from the spec — do not "improve" these in)

- No CSV import, no eBay API, no listing creation/sync, no fees/payout reconciliation, no postage, no eBay buyer records, no automated returns.
- Wants-in-stock queries are untouched: a held card still counts as "in stock" on the wants badge — staff finding it held can use release. Revisit only on real complaint.
- No drag-and-drop reorder, no numbered label sheet (run sheet covers the physical numbering; the label sheet is a fast-follow if the owner asks).
