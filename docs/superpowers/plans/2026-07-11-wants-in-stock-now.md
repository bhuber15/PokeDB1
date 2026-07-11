# Wants In Stock Now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shop-wide want list proactive — surface which wanted cards are sellable right now, show who to phone, and flag the count in the nav — plus scaffold (but do not wire) Phase-2 notifications.

**Architecture:** Move the wants query + `inStock` computation out of the API route into `lib/domain/wants.ts` (routes stay thin). Add a dependency-free `lib/wants-grouping.ts` pure helper the client can import to group in-stock wants by card. Enhance the existing `WantsPanel` in place with an "In stock now" section carrying contact info, a `notify` toggle, and fulfil/sell actions. Add a server-computed count badge to the Customers nav link.

**Tech Stack:** Next.js App Router (server + client components), Drizzle ORM over libsql/Turso, zod, node:test via tsx (in-memory SQLite + jsdom), Tailwind, shadcn/Base UI.

## Global Constraints

- All money is integer pence (GBP) — N/A here (wants carry no money), but never introduce floats.
- Business logic lives in `lib/domain/` functions that take an optional `Db` handle (param named `dbc`, defaulting to the shared `db`) and throw `DomainError(code, message)` from `lib/domain/errors.ts` for expected failures. `DomainError` codes are a FIXED union — valid codes include `NOT_FOUND` and `INVALID_INPUT`; do NOT invent new codes.
- API routes wrap handlers in `guarded()` (`lib/api.ts`) and validate JSON bodies with a zod schema via `parseBody()` (`lib/validation.ts`); parse ids with `parseIdParam()`.
- Client components NEVER value-import from `lib/domain/*` or anything touching `lib/db` — that drags libsql into the browser bundle. Pure constants/helpers shared with the UI go in a dependency-free module (pattern: `lib/adjustment-reasons.ts`). `import type` is always fine.
- Changed behaviour needs a colocated `*.test.ts`/`*.test.tsx`.
- No DB migration is needed: `want_list.notify` (bool, default true) and `want_list.fulfilledAt` already exist.
- Run a single test file with:
  `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test <path>`
- Done-gate for the whole plan: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build` all green.

---

## File Structure

- Create `lib/wants-grouping.ts` — dependency-free row type + pure `groupInStockWants` / `cardLabel`. (Task 1)
- Create `lib/wants-grouping.test.ts` — unit tests for grouping. (Task 1)
- Create `lib/domain/wants.ts` — `listOpenWants`, `countInStockWants`, `setWantNotify`, `sendWantInStockNotification`. (Task 2)
- Create `lib/domain/wants.test.ts` — domain tests over in-memory DB. (Task 2)
- Modify `app/api/wants/route.ts` — thin GET (delegate to domain) + new PATCH + DELETE via `parseIdParam`. (Task 3)
- Modify `components/customers/WantsPanel.tsx` — "In stock now" section + full list. (Task 4)
- Modify `components/customers/WantsPanel.test.tsx` — cover the new UI + notify toggle. (Task 4)
- Modify `app/(app)/layout.tsx` + `components/layout/Nav.tsx` — server-computed Customers count badge. (Task 5)

---

## Task 1: Pure grouping helper (`lib/wants-grouping.ts`)

**Files:**
- Create: `lib/wants-grouping.ts`
- Test: `lib/wants-grouping.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WantRow` — the API/UI row shape (fields listed in Step 3).
  - `interface InStockCustomer { customerId: number; wantId: number; name: string | null; phone: string | null; email: string | null; notify: boolean }`
  - `interface InStockCardGroup { cardId: number; cardName: string | null; label: string; customers: InStockCustomer[] }`
  - `function cardLabel(w: Pick<WantRow, 'cardName' | 'cardSetName' | 'cardSetNumber' | 'freeText'>): string`
  - `function groupInStockWants(wants: WantRow[]): InStockCardGroup[]`

- [ ] **Step 1: Write the failing test**

Create `lib/wants-grouping.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupInStockWants, cardLabel, type WantRow } from './wants-grouping'

function want(partial: Partial<WantRow> & Pick<WantRow, 'id' | 'customerId'>): WantRow {
  return {
    id: partial.id,
    customerId: partial.customerId,
    cardId: partial.cardId ?? null,
    freeText: partial.freeText ?? null,
    notify: partial.notify ?? true,
    createdAt: partial.createdAt ?? '2026-07-11T00:00:00Z',
    customerName: partial.customerName ?? null,
    customerPhone: partial.customerPhone ?? null,
    customerEmail: partial.customerEmail ?? null,
    cardName: partial.cardName ?? null,
    cardSetName: partial.cardSetName ?? null,
    cardSetNumber: partial.cardSetNumber ?? null,
    inStock: partial.inStock ?? false,
  }
}

test('cardLabel formats name, set and number, falling back to free text', () => {
  assert.equal(
    cardLabel({ cardName: 'Pikachu', cardSetName: 'Base Set', cardSetNumber: '58/102', freeText: null }),
    'Pikachu — Base Set #58/102',
  )
  assert.equal(
    cardLabel({ cardName: null, cardSetName: null, cardSetNumber: null, freeText: 'Charizard promo' }),
    'Charizard promo',
  )
})

test('groups multiple in-stock customers under one card', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Pikachu', customerName: 'Zoe', inStock: true }),
    want({ id: 2, customerId: 11, cardId: 3, cardName: 'Pikachu', customerName: 'Amy', inStock: true, notify: false }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].cardId, 3)
  assert.equal(groups[0].cardName, 'Pikachu')
  assert.deepEqual(groups[0].customers.map(c => c.name), ['Amy', 'Zoe']) // sorted by name
  assert.equal(groups[0].customers.find(c => c.wantId === 2)!.notify, false)
})

test('excludes out-of-stock and free-text wants', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Pikachu', inStock: false }),
    want({ id: 2, customerId: 11, cardId: null, freeText: 'Some card', inStock: true }),
  ])
  assert.equal(groups.length, 0)
})

test('orders groups by label', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Zapdos', inStock: true }),
    want({ id: 2, customerId: 11, cardId: 4, cardName: 'Abra', inStock: true }),
  ])
  assert.deepEqual(groups.map(g => g.cardName), ['Abra', 'Zapdos'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test lib/wants-grouping.test.ts`
Expected: FAIL — cannot find module `./wants-grouping`.

- [ ] **Step 3: Write the implementation**

Create `lib/wants-grouping.ts`:

```ts
// Pure, dependency-free helper shared between the wants API row shape (server)
// and the client WantsPanel. Keep it free of any lib/db import so it never
// drags the DB client into a browser bundle (see lib/adjustment-reasons.ts).

export interface WantRow {
  id: number
  customerId: number
  cardId: number | null
  freeText: string | null
  notify: boolean
  createdAt: string
  customerName: string | null
  customerPhone: string | null
  customerEmail: string | null
  cardName: string | null
  cardSetName: string | null
  cardSetNumber: string | null
  inStock: boolean
}

export interface InStockCustomer {
  customerId: number
  wantId: number
  name: string | null
  phone: string | null
  email: string | null
  notify: boolean
}

export interface InStockCardGroup {
  cardId: number
  cardName: string | null
  label: string
  customers: InStockCustomer[]
}

export function cardLabel(
  w: Pick<WantRow, 'cardName' | 'cardSetName' | 'cardSetNumber' | 'freeText'>,
): string {
  if (w.cardName) {
    return `${w.cardName}${w.cardSetName ? ` — ${w.cardSetName}` : ''}${w.cardSetNumber ? ` #${w.cardSetNumber}` : ''}`
  }
  return w.freeText ?? '(unknown)'
}

// One entry per card for wants that are carded AND in stock. Groups collapse
// multiple interested customers under a single card. Deterministic ordering so
// the UI (and tests) are stable.
export function groupInStockWants(wants: WantRow[]): InStockCardGroup[] {
  const byCard = new Map<number, InStockCardGroup>()
  for (const w of wants) {
    if (!w.inStock || w.cardId == null) continue
    let group = byCard.get(w.cardId)
    if (!group) {
      group = { cardId: w.cardId, cardName: w.cardName, label: cardLabel(w), customers: [] }
      byCard.set(w.cardId, group)
    }
    group.customers.push({
      customerId: w.customerId,
      wantId: w.id,
      name: w.customerName,
      phone: w.customerPhone,
      email: w.customerEmail,
      notify: w.notify,
    })
  }
  const groups = [...byCard.values()]
  groups.sort((a, b) => a.label.localeCompare(b.label))
  for (const g of groups) {
    g.customers.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }
  return groups
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test lib/wants-grouping.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/wants-grouping.ts lib/wants-grouping.test.ts
git commit -m "feat: dependency-free helper to group in-stock wants by card"
```

---

## Task 2: Domain layer (`lib/domain/wants.ts`)

**Files:**
- Create: `lib/domain/wants.ts`
- Test: `lib/domain/wants.test.ts`

**Interfaces:**
- Consumes: `WantRow` from `@/lib/wants-grouping` (as the return element type); `Db` from `@/lib/db`; `DomainError` from `./errors`.
- Produces:
  - `listOpenWants(dbc?: Db): Promise<WantRow[]>`
  - `countInStockWants(dbc?: Db): Promise<number>`
  - `setWantNotify(id: number, notify: boolean, dbc?: Db): Promise<void>` — throws `DomainError('NOT_FOUND', …)` if no OPEN want with that id.
  - `interface NotificationResult { sent: boolean; reason: 'provider_not_configured'; wantId: number }`
  - `sendWantInStockNotification(want: WantRow, dbc?: Db): Promise<NotificationResult>` — Phase-2 seam; always returns `{ sent: false, reason: 'provider_not_configured', wantId }`.

- [ ] **Step 1: Write the failing test**

Create `lib/domain/wants.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/test-helpers'
import * as schema from '../db/schema'
import {
  listOpenWants,
  countInStockWants,
  setWantNotify,
  sendWantInStockNotification,
} from './wants'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db
let qrSeq = 0

const isNotFound = (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND'

async function seedCustomer(name: string, phone?: string, email?: string) {
  const [c] = await dbc.insert(schema.customers).values({ name, phone, email }).returning()
  return c
}

async function seedCard(name: string) {
  const [c] = await dbc.insert(schema.cards).values({
    name, setName: 'Base Set', setNumber: '1/1',
  }).returning()
  return c
}

async function stock(cardId: number, isActive = true) {
  qrSeq += 1
  await dbc.insert(schema.inventoryItems).values({
    cardId, quantity: 1, condition: 'NM', costPrice: 100, qrCode: `qr-${qrSeq}`, isActive,
  })
}

beforeEach(async () => {
  dbc = await createTestDb()
})

test('listOpenWants marks a want in stock when an active inventory item exists', async () => {
  const cust = await seedCustomer('Ash', '07700 900111', 'ash@example.com')
  const card = await seedCard('Pikachu')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, true)
  assert.equal(w.customerPhone, '07700 900111')
  assert.equal(w.customerEmail, 'ash@example.com')
  assert.equal(w.cardName, 'Pikachu')
})

test('a want is not in stock when the only inventory row is inactive', async () => {
  const cust = await seedCustomer('Misty')
  const card = await seedCard('Staryu')
  await stock(card.id, false)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, false)
})

test('free-text wants are never in stock', async () => {
  const cust = await seedCustomer('Brock')
  await dbc.insert(schema.wantList).values({ customerId: cust.id, freeText: 'Onix promo' })

  const [w] = await listOpenWants(dbc)
  assert.equal(w.inStock, false)
})

test('fulfilled wants are excluded from listOpenWants and the count', async () => {
  const cust = await seedCustomer('Gary')
  const card = await seedCard('Eevee')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({
    customerId: cust.id, cardId: card.id, fulfilledAt: '2026-07-10T00:00:00Z',
  })

  assert.equal((await listOpenWants(dbc)).length, 0)
  assert.equal(await countInStockWants(dbc), 0)
})

test('countInStockWants counts only in-stock open wants', async () => {
  const cust = await seedCustomer('Jessie')
  const inStockCard = await seedCard('Meowth')
  const outCard = await seedCard('Wobbuffet')
  await stock(inStockCard.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: inStockCard.id })
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: outCard.id })

  assert.equal(await countInStockWants(dbc), 1)
})

test('setWantNotify flips the flag', async () => {
  const cust = await seedCustomer('James')
  const [want] = await dbc.insert(schema.wantList)
    .values({ customerId: cust.id, freeText: 'Arbok', notify: true }).returning()

  await setWantNotify(want.id, false, dbc)

  const [row] = await dbc.select().from(schema.wantList)
    .where(eq(schema.wantList.id, want.id))
  assert.equal(row.notify, false)
})

test('setWantNotify throws NOT_FOUND for a missing want', async () => {
  await assert.rejects(() => setWantNotify(9999, false, dbc), isNotFound)
})

test('sendWantInStockNotification reports the provider is not configured', async () => {
  const cust = await seedCustomer('Nurse Joy')
  const card = await seedCard('Chansey')
  await stock(card.id, true)
  await dbc.insert(schema.wantList).values({ customerId: cust.id, cardId: card.id })
  const [w] = await listOpenWants(dbc)

  const result = await sendWantInStockNotification(w, dbc)
  assert.deepEqual(result, { sent: false, reason: 'provider_not_configured', wantId: w.id })
})
```

> Note: seed column names are verified against `lib/db/schema.ts` — `cards` requires `name`/`setName`/`setNumber`; `inventory_items` requires `condition`/`costPrice`/`qrCode` (unique). If the schema changes, adjust the seed helpers, not the schema.

- [ ] **Step 2: Run test to verify it fails**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test lib/domain/wants.test.ts`
Expected: FAIL — cannot find module `./wants`.

- [ ] **Step 3: Write the implementation**

Create `lib/domain/wants.ts`:

```ts
import { eq, isNull, and, inArray, desc } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { wantList, cards, customers, inventoryItems } from '@/lib/db/schema'
import { DomainError } from './errors'
import type { WantRow } from '@/lib/wants-grouping'

// Every open want (fulfilledAt IS NULL), enriched with customer contact + card
// info, plus an inStock flag derived from active inventory for the card.
export async function listOpenWants(dbc: Db = db): Promise<WantRow[]> {
  const wants = await dbc
    .select({
      id: wantList.id,
      customerId: wantList.customerId,
      cardId: wantList.cardId,
      freeText: wantList.freeText,
      notify: wantList.notify,
      createdAt: wantList.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      cardName: cards.name,
      cardSetName: cards.setName,
      cardSetNumber: cards.setNumber,
    })
    .from(wantList)
    .leftJoin(customers, eq(wantList.customerId, customers.id))
    .leftJoin(cards, eq(wantList.cardId, cards.id))
    .where(isNull(wantList.fulfilledAt))
    .orderBy(desc(wantList.createdAt))

  const cardIds = wants.map(w => w.cardId).filter((id): id is number => id != null)

  let inStockSet = new Set<number>()
  if (cardIds.length > 0) {
    const activeRows = await dbc
      .select({ cardId: inventoryItems.cardId })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.isActive, true), inArray(inventoryItems.cardId, cardIds)))
    inStockSet = new Set(activeRows.map(r => r.cardId).filter((id): id is number => id != null))
  }

  return wants.map(w => ({
    ...w,
    inStock: w.cardId != null ? inStockSet.has(w.cardId) : false,
  }))
}

// Count of open wants that are sellable right now — powers the nav badge.
export async function countInStockWants(dbc: Db = db): Promise<number> {
  const wants = await listOpenWants(dbc)
  return wants.filter(w => w.inStock).length
}

// Toggle whether the customer should be contacted when their want is in stock.
export async function setWantNotify(id: number, notify: boolean, dbc: Db = db): Promise<void> {
  const [row] = await dbc
    .update(wantList)
    .set({ notify })
    .where(and(eq(wantList.id, id), isNull(wantList.fulfilledAt)))
    .returning({ id: wantList.id })
  if (!row) throw new DomainError('NOT_FOUND', 'Want not found')
}

export interface NotificationResult {
  sent: boolean
  reason: 'provider_not_configured'
  wantId: number
}

// Phase-2 seam: the single place a real email/SMS provider will plug in. No
// provider is wired yet, so this sends nothing and reports why. Intentionally
// not called from any route in this build.
export async function sendWantInStockNotification(
  want: WantRow,
  dbc: Db = db,
): Promise<NotificationResult> {
  void dbc // reserved for the future provider lookup / audit write
  return { sent: false, reason: 'provider_not_configured', wantId: want.id }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test lib/domain/wants.test.ts`
Expected: PASS (8 tests). If an insert fails on a NOT NULL column, adjust the seed helpers in the test to supply it (see the note in Step 1).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/wants.ts lib/domain/wants.test.ts
git commit -m "feat: wants domain layer (list, count, notify toggle, notify seam)"
```

---

## Task 3: Thin the API route + add PATCH (`app/api/wants/route.ts`)

**Files:**
- Modify: `app/api/wants/route.ts` (full rewrite of the file — content below)

**Interfaces:**
- Consumes: `listOpenWants`, `setWantNotify` from `@/lib/domain/wants`; `parseBody`, `parseIdParam` from `@/lib/validation`; `guarded` from `@/lib/api`.
- Produces: `GET` returns `{ wants: WantRow[] }`; `PATCH /api/wants?id=<n>` body `{ notify: boolean }` returns `{ ok: true }`; `POST`/`DELETE` unchanged in behaviour.

- [ ] **Step 1: Replace the route file**

There is no route-level test (routes import `next/server`; behaviour is covered by the domain tests in Task 2). Replace the entire contents of `app/api/wants/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { wantList } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { listOpenWants, setWantNotify } from '@/lib/domain/wants'

const createWantBody = z.object({
  customerId: z.number().int(),
  cardId: z.number().int().nullable().optional(),
  freeText: z.string().nullable().optional(),
}).refine(b => b.cardId != null || b.freeText?.trim(), 'Either cardId or freeText is required')

const patchWantBody = z.object({ notify: z.boolean() })

export const GET = guarded(async () => {
  requireStaff(await getSession())
  const wants = await listOpenWants()
  return NextResponse.json({ wants })
})

export const POST = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const { customerId, cardId, freeText } = await parseBody(req, createWantBody)

  const [item] = await db.insert(wantList).values({
    customerId,
    cardId: cardId ?? null,
    freeText: freeText?.trim() ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
})

export const PATCH = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const id = parseIdParam(req.nextUrl.searchParams.get('id'))
  const { notify } = await parseBody(req, patchWantBody)
  await setWantNotify(id, notify)

  return NextResponse.json({ ok: true })
})

export const DELETE = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const id = parseIdParam(req.nextUrl.searchParams.get('id'))

  await db
    .update(wantList)
    .set({ fulfilledAt: new Date().toISOString() })
    .where(eq(wantList.id, id))

  return NextResponse.json({ ok: true })
})
```

- [ ] **Step 2: Typecheck the route**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). Confirms the domain imports and removed symbols line up.

- [ ] **Step 3: Verify existing wants tests still pass**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test lib/domain/wants.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 4: Commit**

```bash
git add app/api/wants/route.ts
git commit -m "refactor: thin wants GET onto domain, add notify PATCH"
```

---

## Task 4: "In stock now" UI (`components/customers/WantsPanel.tsx`)

**Files:**
- Modify: `components/customers/WantsPanel.tsx` (full rewrite — content below)
- Test: `components/customers/WantsPanel.test.tsx` (full rewrite — content below)

**Interfaces:**
- Consumes: `groupInStockWants`, `cardLabel`, `type WantRow` from `@/lib/wants-grouping`; `GET`/`PATCH`/`DELETE /api/wants`.
- Produces: the `WantsPanel` component (same export, used by `app/(app)/customers/page.tsx`).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `components/customers/WantsPanel.test.tsx` with:

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { WantsPanel } from './WantsPanel'

afterEach(cleanup)

let fetchCalls: { url: string; init?: RequestInit }[] = []

function mockFetch(body: unknown, ok = true) {
  fetchCalls = []
  global.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    return { ok, json: async () => body }
  }) as unknown as typeof fetch
}

function want(overrides: Record<string, unknown>) {
  return {
    id: 1, customerId: 7, cardId: 3, freeText: null, notify: true,
    createdAt: new Date().toISOString(),
    customerName: 'Ash Ketchum', customerPhone: '07700 900111', customerEmail: 'ash@example.com',
    cardName: 'Pikachu', cardSetName: 'Base Set', cardSetNumber: '58/102',
    inStock: true, ...overrides,
  }
}

test('shows an in-stock want with contact info and a Sell link to the card', async () => {
  mockFetch({ wants: [want({})] })

  render(<WantsPanel />)

  await screen.findByText('Ash Ketchum')
  assert.ok(screen.getByText('07700 900111'))
  assert.ok(screen.getByText('ash@example.com'))
  const sellLinks = screen.getAllByRole('link', { name: /sell/i })
  assert.ok(sellLinks.some(a => a.getAttribute('href') === '/pos?q=Pikachu'))
})

test('empty in-stock section when the only want is a free-text miss', async () => {
  mockFetch({ wants: [want({
    id: 2, cardId: null, freeText: 'Charizard VMAX secret rare',
    cardName: null, cardSetName: null, cardSetNumber: null, inStock: false,
  })] })

  render(<WantsPanel />)

  await screen.findByText('No wanted cards are in stock right now')
  assert.ok(screen.getByText('Charizard VMAX secret rare'))
  assert.equal(screen.queryByRole('link', { name: /sell/i }), null)
})

test('shows both empty states when there are no open wants', async () => {
  mockFetch({ wants: [] })

  render(<WantsPanel />)

  assert.ok(await screen.findByText('No open wants'))
  assert.ok(screen.getByText('No wanted cards are in stock right now'))
})

test('toggling notify PATCHes the want', async () => {
  mockFetch({ wants: [want({})] })

  render(<WantsPanel />)

  const checkbox = await screen.findByLabelText(/notify/i)
  fireEvent.click(checkbox)
  await new Promise(r => setTimeout(r, 0))

  const patch = fetchCalls.find(c => c.init?.method === 'PATCH')
  assert.ok(patch, 'expected a PATCH call')
  assert.equal(patch!.url, '/api/wants?id=1')
  assert.deepEqual(JSON.parse(patch!.init!.body as string), { notify: false })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test components/customers/WantsPanel.test.tsx`
Expected: FAIL — the new section text / contact fields / notify checkbox don't exist yet.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `components/customers/WantsPanel.tsx` with:

```tsx
'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { groupInStockWants, cardLabel, type WantRow } from '@/lib/wants-grouping'

// Shop-wide want list: a proactive "in stock now" section (who to call) plus
// the full open list underneath.
export function WantsPanel() {
  const [wants, setWants] = useState<WantRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/wants')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setWants(data.wants ?? [])
    } catch {
      toast.error('Could not load want list')
    } finally {
      setLoading(false)
    }
  }, [])

  // Timer defers the fetch past the effect's sync phase (set-state-in-effect)
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  const inStockGroups = useMemo(() => groupInStockWants(wants), [wants])

  async function markDone(id: number) {
    try {
      const res = await fetch(`/api/wants?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setWants(prev => prev.filter(w => w.id !== id))
      toast.success('Want removed')
    } catch {
      toast.error('Could not remove want')
    }
  }

  async function toggleNotify(id: number, notify: boolean) {
    setWants(prev => prev.map(w => (w.id === id ? { ...w, notify } : w)))
    try {
      const res = await fetch(`/api/wants?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setWants(prev => prev.map(w => (w.id === id ? { ...w, notify: !notify } : w)))
      toast.error('Could not update notify')
    }
  }

  return (
    <div className="space-y-6">
      {/* In stock now — ready to sell */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">In stock now — ready to sell</h2>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border">Loading…</div>
        ) : inStockGroups.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border">
            No wanted cards are in stock right now
          </div>
        ) : (
          <div className="space-y-3">
            {inStockGroups.map(group => (
              <div key={group.cardId} className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-emerald-400/20">
                  <span className="font-medium text-emerald-300">{group.label}</span>
                  <Link
                    href={`/pos?q=${encodeURIComponent(group.cardName ?? group.label)}`}
                    className="text-xs font-semibold text-emerald-400 hover:underline"
                  >
                    Sell →
                  </Link>
                </div>
                <ul className="divide-y divide-border/40">
                  {group.customers.map(c => (
                    <li key={c.wantId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <Link href={`/customers/${c.customerId}`} className="font-medium hover:underline">
                          {c.name ?? `Customer #${c.customerId}`}
                        </Link>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 mt-0.5">
                          <span>{c.phone ?? 'no phone'}</span>
                          <span>{c.email ?? 'no email'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            checked={c.notify}
                            onChange={e => toggleNotify(c.wantId, e.target.checked)}
                          />
                          Notify
                        </label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => markDone(c.wantId)}
                        >
                          Mark fulfilled
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Full open list */}
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">All open customer wants — green = in stock now</p>
        <div className="rounded-xl border border-border overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
          ) : wants.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No open wants</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  {['Customer', 'Card / Item', 'Status', ''].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wants.map(w => (
                  <tr key={w.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/customers/${w.customerId}`} className="hover:underline">
                        {w.customerName ?? `Customer #${w.customerId}`}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={w.inStock ? 'text-emerald-400 font-medium' : ''}>
                        {cardLabel(w)}
                      </span>
                      {w.freeText && w.cardName == null && (
                        <span className="ml-1.5 text-xs text-muted-foreground">(free text)</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {w.inStock ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                          In stock
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted/50 border border-border px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block" />
                          Not in stock
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => markDone(w.id)}
                      >
                        Done / Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
```

> Note: the full table's per-row "Sell →" link is removed (selling is now driven from the grouped in-stock section) so the test's Sell-link assertions target only the grouped section.

- [ ] **Step 4: Run test to verify it passes**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --import ./tests/dom-setup.ts --test components/customers/WantsPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add components/customers/WantsPanel.tsx components/customers/WantsPanel.test.tsx
git commit -m "feat: in-stock-now section with contacts and notify toggle in WantsPanel"
```

---

## Task 5: Nav count badge (`app/(app)/layout.tsx`, `components/layout/Nav.tsx`)

**Files:**
- Modify: `app/(app)/layout.tsx`
- Modify: `components/layout/Nav.tsx`

**Interfaces:**
- Consumes: `countInStockWants` from `@/lib/domain/wants`.
- Produces: `Nav` gains an optional `inStockWantsCount?: number` prop; renders a count `Badge` on the Customers link when `> 0`.

- [ ] **Step 1: Pass the count from the server layout**

In `app/(app)/layout.tsx`, add the import and compute the count, then pass it to `<Nav>`. The file becomes:

```tsx
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { countInStockWants } from '@/lib/domain/wants'
import { Nav } from '@/components/layout/Nav'
import { SettingsProvider } from '@/components/shared/SettingsProvider'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session.staffId) redirect('/pin')
  const settings = await getSettings()
  const inStockWantsCount = await countInStockWants()
  return (
    <SettingsProvider value={settings}>
      <div className="min-h-screen bg-background">
        <Nav
          shopName={settings.shopName}
          staffName={session.staffName}
          staffRole={session.staffRole}
          inStockWantsCount={inStockWantsCount}
        />
        <main className="container mx-auto px-4 py-6">{children}</main>
      </div>
    </SettingsProvider>
  )
}
```

- [ ] **Step 2: Render the badge on the Customers link**

In `components/layout/Nav.tsx`:

1. Extend `NavProps` with `inStockWantsCount?: number` and destructure it (default `0`):

```tsx
interface NavProps {
  shopName?: string
  staffName?: string
  staffRole?: string
  inStockWantsCount?: number
}

export function Nav({ shopName = 'PokeDB', staffName, staffRole, inStockWantsCount = 0 }: NavProps) {
```

2. Add a `badge` field to the Customers link entry only:

```tsx
    { href: '/customers', label: 'Customers', icon: UserIcon, badge: inStockWantsCount },
```

(Leave the other link entries unchanged — they have no `badge` field.)

3. Inside the `links.map(...)` return, after the `{l.label}` text, render the badge:

```tsx
                <Icon className="size-4" aria-hidden="true" />
                {l.label}
                {'badge' in l && l.badge && l.badge > 0 ? (
                  <Badge
                    className="ml-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                    aria-label={`${l.badge} wanted cards in stock`}
                  >
                    {l.badge}
                  </Badge>
                ) : null}
```

`Badge` is already imported at the top of the file. TypeScript narrows `'badge' in l` because only the Customers entry carries the field.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. If TS complains that `badge` doesn't exist on the union of link objects, give the array an explicit type by adding `badge?: number` — e.g. declare the links with `const links: { href: string; label: string; icon: typeof UserIcon; badge?: number }[] = [ ... ]` and drop the `'badge' in l` guard in favour of `l.badge && l.badge > 0`.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/layout.tsx" components/layout/Nav.tsx
git commit -m "feat: Customers nav badge counting wanted cards in stock"
```

---

## Final verification (run after all tasks)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — all suites, including the new `wants`, `wants-grouping`, and updated `WantsPanel` tests.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. (Watch for unused imports removed from the wants route.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Final commit (if anything was fixed during verification)**

```bash
git add -A
git commit -m "chore: F4 wants-in-stock-now verification fixes"
```

---

## Phase 2 (deferred — not in this plan)

- Wire a real email/SMS provider inside `sendWantInStockNotification` (currently returns `provider_not_configured`).
- Call it (e.g. a "Notify customer" action or a background sweep) honouring `notify`, and record delivery.
- Optionally auto-set `fulfilledAt` on successful notify. None of this ships without the owner's go-ahead on a provider + cost.
```
