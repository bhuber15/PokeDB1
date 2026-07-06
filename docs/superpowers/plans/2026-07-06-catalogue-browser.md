# Catalogue Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff browse the fully-imported ~20k-card local catalogue by set (grouped by era) or by exact Pokémon name, as a standalone `/catalogue` tab and embedded in the Buy page, so buylist intake never depends on knowing a card's exact name/spelling or on the live-search fallback that currently freezes.

**Architecture:** Four new read-only `app/api/cards/*` routes backed by a new `lib/domain/catalogue.ts` query module (plain `db.select()` queries, no writes), plus one shared `CatalogueBrowser` client component reused on a new nav tab and embedded in the Buy page behind a Search\|Browse toggle. A new nullable `cards.series` column (backfilled once, captured going forward by the nightly price sweep) provides the era grouping.

**Tech Stack:** Next.js App Router route handlers, Drizzle ORM against Turso/libsql, React 19 client components, Tailwind v4, `node:test` via `tsx` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-06-catalogue-browser-design.md`

## Global Constraints

- All four new API routes wrap in `guarded()` (`lib/api.ts`) and call `requireStaff(await getSession())` (`lib/auth.ts`) — identical to every existing `/api/cards/*` route. No new auth surface.
- Client components (`CatalogueBrowser` and both host pages) are `'use client'` and only talk to the server via `fetch('/api/...')` — never a value-import from `lib/domain/*` or anything touching `lib/db`, per the repo's client-bundle boundary rule (`AGENTS.md`).
- This codebase's actual test convention (verified — no `route.test.ts` files exist anywhere in `app/api/`) is: put logic + tests at the `lib/domain/*` layer; route handlers stay thin, untested wrappers. Follow that, not a route-level testing pattern.
- Tests run via `TURSO_DATABASE_URL=:memory: node --import tsx --test <glob>` (this is what `npm test` runs). The `@/*` path alias resolves inside `lib/` source files under this runner; test files use relative imports, matching every existing `lib/**/*.test.ts`.
- Standalone scripts (`scripts/*.ts`) import `./load-env` first, use relative imports (not `@/*`), and end with `main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })` — no colocated test file (verified: no existing script has one).
- Largest possible result set from any new endpoint is 304 rows (biggest set) or a 50-row capped name list — no pagination, cursors, or virtualization needed anywhere in this feature.

---

## File Structure

- `lib/db/schema.ts` — add `series: text('series')` to the `cards` table.
- `lib/db/migrations/00NN_*.sql` — generated migration for the new column.
- `lib/apis/pokemon-tcg.ts` — add `fetchSets()` + `PokemonTCGSet` interface (one-shot `/v2/sets` call for the backfill script).
- `lib/prices/sync.ts` — `upsertPage` starts writing `series` from `c.set?.series` on insert and conflict-update.
- `lib/prices/sync.test.ts` — extend the existing sweep test to assert `series` is captured.
- `scripts/backfill-series.ts` (new) — one-time backfill of `series` for rows imported before the column existed.
- `lib/domain/catalogue.ts` (new) — read-only query module: `getSets`, `getCardsInSet`, `getNames`, `getPrintingsByName`, plus the `SERIES_ORDER` era-ordering table.
- `lib/domain/catalogue.test.ts` (new) — unit tests for all four functions.
- `app/api/cards/sets/route.ts` (new)
- `app/api/cards/browse/route.ts` (new)
- `app/api/cards/names/route.ts` (new)
- `app/api/cards/browse-by-name/route.ts` (new)
- `components/catalogue/CatalogueBrowser.tsx` (new) — shared client component (set/name toggle, grid, `onSelectCard` callback prop).
- `app/(app)/catalogue/page.tsx` (new) — standalone tab; wires `onSelectCard` to `CardZoomModal`.
- `components/layout/Nav.tsx` — add a "Catalogue" link.
- `app/(app)/buylist/page.tsx` — add a Search\|Browse toggle; Browse mode renders `CatalogueBrowser` and feeds selections into the existing `results`/`BuyCard` add-to-cart flow.

---

## Task 1: `cards.series` column + nightly-sweep capture

**Files:**
- Modify: `lib/db/schema.ts:13-25` (the `cards` table)
- Modify: `lib/prices/sync.ts:107-147` (`upsertPage`'s insert/conflict-update)
- Modify: `lib/prices/sync.test.ts`
- Create: `lib/db/migrations/00NN_<generated-name>.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `cards.series: string | null` — every later task that reads `Card` (via `typeof cards.$inferSelect`) sees this field automatically.

- [ ] **Step 1: Add the column to the schema**

In `lib/db/schema.ts`, inside the `cards` table definition, add `series` right after `variant`:

```ts
export const cards = sqliteTable('cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  game: text('game').notNull().default('pokemon'),
  setName: text('set_name').notNull(),
  setNumber: text('set_number').notNull(),
  variant: text('variant'),
  series: text('series'), // era/series, e.g. "Sword & Shield" — nullable, backfilled by scripts/backfill-series.ts
  language: text('language').notNull().default('EN'),
  externalId: text('external_id').unique(),
  tcgplayerId: text('tcgplayer_id'),
  imageUrl: text('image_url'),
  imageUrlLarge: text('image_url_large'),
})
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `lib/db/migrations/00NN_*.sql` containing exactly one statement: `ALTER TABLE `cards` ADD `series` text;` (matches the shape of the existing `0009_sale-client-uuid.sql`, which adds one nullable column the same way).

- [ ] **Step 3: Verify migrations still apply cleanly**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/db/test-helpers.test.ts`
Expected: both existing tests pass — this confirms `createTestDb()` (which applies every migration in journal order) picks up the new one without error.

- [ ] **Step 4: Capture `series` in the nightly sweep**

In `lib/prices/sync.ts`, in `upsertPage`'s insert values (around line 126-134), add `series` next to `variant`:

```ts
    const rows = await dbc.insert(cards).values(chunk.map(c => ({
      name: c.name,
      game: 'pokemon',
      setName: c.set?.name ?? '',
      setNumber: c.number ?? '',
      variant: c.subtypes?.join('/') ?? null,
      series: c.set?.series ?? null,
      externalId: c.id,
      imageUrl: c.images?.small ?? null,
      imageUrlLarge: c.images?.large ?? null,
    }))).onConflictDoUpdate({
      target: cards.externalId,
      set: {
        name: sql`excluded.name`,
        setName: sql`excluded.set_name`,
        setNumber: sql`excluded.set_number`,
        variant: sql`excluded.variant`,
        series: sql`excluded.series`,
        imageUrl: sql`excluded.image_url`,
        imageUrlLarge: sql`excluded.image_url_large`,
      },
    }).returning({ id: cards.id, externalId: cards.externalId })
```

- [ ] **Step 5: Extend the sweep test to assert series is captured**

In `lib/prices/sync.test.ts`, the `apiCard()` test helper already returns `set: { name: 'Test Set', series: 'T', releaseDate: '2026/01/01' }` — add an assertion to the existing `'sweep inserts unknown cards and refreshes prices for known ones'` test (this makes it a red→green change: the assertion fails until Step 4 lands):

```ts
test('sweep inserts unknown cards and refreshes prices for known ones', async () => {
  stubFetch({
    pages: {
      1: { data: [apiCard('base1-58', 'Pikachu', 5), apiCard('sv1-1', 'Sprigatito', 2)], totalCount: 2 },
    },
  })
  const result = await sweepTcgplayerCatalogue(SETTINGS, {}, db)
  assert.equal(result.pagesFetched, 1)
  assert.equal(result.cardsSeen, 2)
  assert.equal(result.newCards, 1) // Sprigatito; Pikachu already existed

  const allCards = await db.select().from(schema.cards)
  assert.equal(allCards.length, 2)
  assert.ok(allCards.every(c => c.series === 'T'), 'series captured from the API for every card')
  const [pikachuPrice] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, 1))
  assert.equal(pikachuPrice.tcgplayerMarket, 400) // $5 × 0.8 × 100
})
```

- [ ] **Step 6: Run the sync test suite**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/prices/sync.test.ts`
Expected: all tests pass, including the extended assertion.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations lib/prices/sync.ts lib/prices/sync.test.ts
git commit -m "feat: capture card series/era from the Pokemon TCG API"
```

---

## Task 2: `fetchSets()` + one-time series backfill script

**Files:**
- Modify: `lib/apis/pokemon-tcg.ts`
- Create: `scripts/backfill-series.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (the schema column already exists after Task 1).
- Produces: `fetchSets(): Promise<PokemonTCGSet[]>` where `PokemonTCGSet = { name: string; series: string }` — not consumed by any later task (script-only), but exported for potential reuse.

- [ ] **Step 1: Add `fetchSets()` to the Pokemon TCG API client**

In `lib/apis/pokemon-tcg.ts`, add after `fetchCardPage`:

```ts
export interface PokemonTCGSet {
  name: string
  series: string
}

// Full set list in one call (174 sets as of 2026-07, well under one page) —
// used once by the series backfill script. The per-card sweep doesn't need
// this: it already gets set.series inline via each card's `set` field.
export async function fetchSets(): Promise<PokemonTCGSet[]> {
  const params = new URLSearchParams({ pageSize: '250', select: 'name,series' })
  const res = await fetch(`${BASE_URL}/sets?${params}`, {
    headers: headers(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`)
  return (await res.json()).data as PokemonTCGSet[]
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Write the backfill script**

Create `scripts/backfill-series.ts`:

```ts
// One-time: populate cards.series for rows imported before the column
// existed. Fetches the full Pokemon TCG API set list once (174 sets, a
// single request — not a per-card sweep) and updates cards.series by
// matching set_name. Safe to re-run: only touches rows where series IS NULL.
import './load-env'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../lib/db'
import { cards } from '../lib/db/schema'
import { fetchSets } from '../lib/apis/pokemon-tcg'

async function main() {
  const sets = await fetchSets()
  const bySetName = new Map(sets.map(s => [s.name, s.series]))

  const localSetNames = await db.selectDistinct({ setName: cards.setName }).from(cards)

  let matched = 0
  let unmatched = 0
  for (const { setName } of localSetNames) {
    const series = bySetName.get(setName)
    if (!series) {
      console.log(`no API match for set "${setName}" — leaving series NULL`)
      unmatched++
      continue
    }
    await db.update(cards)
      .set({ series })
      .where(and(eq(cards.setName, setName), isNull(cards.series)))
    matched++
  }
  console.log(`Done: ${matched} sets matched and updated, ${unmatched} sets had no API match.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/apis/pokemon-tcg.ts scripts/backfill-series.ts
git commit -m "feat: add series backfill script for existing catalogue rows"
```

*(Running `npx tsx scripts/backfill-series.ts` against the real dev DB is an owner/operator step — same category as `scripts/import-catalogue.ts` in `AGENTS.md` — not part of automated verification for this plan.)*

---

## Task 3: Domain queries — browse by set

**Files:**
- Create: `lib/domain/catalogue.ts`
- Create: `lib/domain/catalogue.test.ts`

**Interfaces:**
- Consumes: `cards.series` (Task 1), `db`/`Db` (`lib/db`), `cards`/`priceCache` (`lib/db/schema`).
- Produces: `SERIES_ORDER: readonly string[]`, `SetSummary { setName: string; series: string | null; count: number }`, `CatalogueRow { card: Card; prices: PriceCache | null }`, `getSets(dbc?: Db): Promise<SetSummary[]>`, `getCardsInSet(setName: string, dbc?: Db): Promise<CatalogueRow[]>` — all consumed by Task 5's API routes and by Task 4 (which shares `CatalogueRow`).

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/catalogue.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getSets, getCardsInSet } from './catalogue'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc) // card id 1 'Pikachu', 'Base Set', setNumber '58/102', series null
})

test('getSets groups by set name + series, ordered by era then name, with counts', async () => {
  await dbc.update(schema.cards).set({ series: 'Base' }).where(eq(schema.cards.id, 1))
  await dbc.insert(schema.cards).values([
    { name: 'Charizard', setName: 'Base Set', setNumber: '4', series: 'Base' },
    { name: 'Sprigatito', setName: 'Scarlet & Violet', setNumber: '1', series: 'Scarlet & Violet' },
    { name: 'Old Card', setName: 'Mystery Set', setNumber: '1', series: null },
  ])

  const sets = await getSets(dbc)
  assert.deepEqual(sets.map(s => s.setName), ['Base Set', 'Scarlet & Violet', 'Mystery Set'])
  assert.equal(sets.find(s => s.setName === 'Base Set')!.count, 2)
  assert.equal(sets.find(s => s.setName === 'Mystery Set')!.series, null)
})

test('getCardsInSet returns all cards in a set ordered by set number, joined to prices', async () => {
  await dbc.update(schema.cards).set({ setNumber: '10' }).where(eq(schema.cards.id, 1))
  const [raichu] = await dbc.insert(schema.cards)
    .values({ name: 'Raichu', setName: 'Base Set', setNumber: '2' })
    .returning({ id: schema.cards.id })
  await dbc.insert(schema.priceCache).values({ cardId: raichu.id, tcgplayerMarket: 500 })

  const rows = await getCardsInSet('Base Set', dbc)
  assert.deepEqual(rows.map(r => r.card.name), ['Raichu', 'Pikachu']) // '2' before '10' numerically
  assert.equal(rows.find(r => r.card.name === 'Raichu')!.prices?.tcgplayerMarket, 500)
  assert.equal(rows.find(r => r.card.name === 'Pikachu')!.prices, null)
})

test('getCardsInSet returns nothing for an unknown set name', async () => {
  const rows = await getCardsInSet('Nonexistent Set', dbc)
  assert.deepEqual(rows, [])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/domain/catalogue.test.ts`
Expected: FAIL — `Cannot find module './catalogue'` (the module doesn't exist yet).

- [ ] **Step 3: Implement the module**

Create `lib/domain/catalogue.ts`:

```ts
// lib/domain/catalogue.ts
//
// Read-only catalogue browsing: sets grouped by era, all cards in a set,
// distinct card names, and every printing of an exact name. Powers the
// Catalogue tab and the Buy page's Browse mode. No writes — unlike
// sales/refunds/buys, this module has no domain invariants to enforce.

import { and, asc, eq, like, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import type { Card, PriceCache } from '@/lib/db/schema'

// Chronological release order. A series not listed here (including null —
// pre-backfill rows, or a set the API hasn't categorised yet) sorts last,
// into an "Other" bucket in the UI.
export const SERIES_ORDER = [
  'Base', 'Neo', 'Gym', 'e-Card', 'EX', 'Diamond & Pearl', 'Platinum',
  'HeartGold & SoulSilver', 'Call of Legends', 'Black & White',
  'XY', 'Sun & Moon', 'Sword & Shield', 'Scarlet & Violet',
] as const

function seriesRank(series: string | null): number {
  if (series == null) return SERIES_ORDER.length + 1
  const idx = (SERIES_ORDER as readonly string[]).indexOf(series)
  return idx === -1 ? SERIES_ORDER.length : idx
}

// Set numbers are mostly numeric strings ("58", "TG12") — compare
// numerically when both sides parse as plain numbers, else fall back to
// string comparison, so "9" sorts before "10".
function naturalCompare(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b)
}

export interface SetSummary {
  setName: string
  series: string | null
  count: number
}

/** Every distinct set in the catalogue, ordered by era then set name. */
export async function getSets(dbc: Db = db): Promise<SetSummary[]> {
  const rows = await dbc
    .select({ setName: cards.setName, series: cards.series, count: sql<number>`COUNT(*)` })
    .from(cards)
    .groupBy(cards.setName, cards.series)
  return rows.sort((a, b) =>
    seriesRank(a.series) - seriesRank(b.series) || a.setName.localeCompare(b.setName))
}

export interface CatalogueRow {
  card: Card
  prices: PriceCache | null
}

/** All cards in one set, ordered by set number, left-joined to price_cache. */
export async function getCardsInSet(setName: string, dbc: Db = db): Promise<CatalogueRow[]> {
  const rows = await dbc
    .select({ card: cards, prices: priceCache })
    .from(cards)
    .leftJoin(priceCache, eq(priceCache.cardId, cards.id))
    .where(eq(cards.setName, setName))
  return rows.sort((a, b) => naturalCompare(a.card.setNumber, b.card.setNumber))
}

const NAME_LIMIT = 50

/** Distinct card names, optionally prefix-filtered, capped and alphabetised. */
export async function getNames(q: string | undefined, dbc: Db = db): Promise<string[]> {
  const rows = await dbc.selectDistinct({ name: cards.name }).from(cards)
    .where(like(cards.name, `${q ?? ''}%`))
    .orderBy(asc(cards.name))
    .limit(NAME_LIMIT)
  return rows.map(r => r.name)
}

/** Every printing of an exact card name, ordered by era then set number. */
export async function getPrintingsByName(name: string, dbc: Db = db): Promise<CatalogueRow[]> {
  const rows = await dbc
    .select({ card: cards, prices: priceCache })
    .from(cards)
    .leftJoin(priceCache, eq(priceCache.cardId, cards.id))
    .where(eq(cards.name, name))
  return rows.sort((a, b) =>
    seriesRank(a.card.series) - seriesRank(b.card.series) || naturalCompare(a.card.setNumber, b.card.setNumber))
}
```

(`getNames` and `getPrintingsByName` are implemented here too since they share the file and the sort helpers — Task 4 writes their tests.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/domain/catalogue.test.ts`
Expected: PASS (3 tests: getSets grouping/ordering, getCardsInSet ordering+prices, getCardsInSet empty case).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/catalogue.ts lib/domain/catalogue.test.ts
git commit -m "feat: catalogue domain queries — browse by set"
```

---

## Task 4: Domain queries — browse by Pokémon name

**Files:**
- Modify: `lib/domain/catalogue.test.ts` (add tests — `getNames`/`getPrintingsByName` implementations already landed in Task 3)

**Interfaces:**
- Consumes: `getNames`, `getPrintingsByName`, `CatalogueRow` from Task 3's `lib/domain/catalogue.ts`.
- Produces: nothing new — this task is test coverage for functions Task 3 already implemented, split out because it covers the second, independent browse mode and a reviewer may want to approve set-browsing without blocking on name-browsing (or vice versa).

- [ ] **Step 1: Update the import line, then append the tests**

In `lib/domain/catalogue.test.ts`, change the existing import (added in Task 3) from:

```ts
import { getSets, getCardsInSet } from './catalogue'
```

to:

```ts
import { getSets, getCardsInSet, getNames, getPrintingsByName } from './catalogue'
```

Then append these two tests to the end of the file:

```ts
test('getNames returns distinct names, prefix-filtered and capped, alphabetised', async () => {
  await dbc.insert(schema.cards).values([
    { name: 'Pikachu VMAX', setName: 'Base Set', setNumber: '2' },
    { name: 'Raichu', setName: 'Base Set', setNumber: '3' },
  ])
  const all = await getNames(undefined, dbc)
  assert.deepEqual([...all].sort(), ['Pikachu', 'Pikachu VMAX', 'Raichu'])

  const filtered = await getNames('Pika', dbc)
  assert.deepEqual(filtered, ['Pikachu', 'Pikachu VMAX'])
})

test('getPrintingsByName returns every printing of an exact name, ordered by era then set number', async () => {
  // seeded card: id 1, 'Pikachu', 'Base Set', setNumber '58/102', series null
  await dbc.insert(schema.cards).values({
    name: 'Pikachu', setName: 'Sword & Shield Base', setNumber: '4', series: 'Sword & Shield',
  })
  await dbc.insert(schema.cards).values({ name: 'Pikachu VMAX', setName: 'Base Set', setNumber: '1' }) // different name, excluded

  const rows = await getPrintingsByName('Pikachu', dbc)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.card.setName), ['Sword & Shield Base', 'Base Set']) // ranked era before null-series seed row
})
```

- [ ] **Step 2: Run the tests**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/domain/catalogue.test.ts`
Expected: PASS (5 tests total: the 3 from Task 3 plus these 2).

- [ ] **Step 3: Commit**

```bash
git add lib/domain/catalogue.test.ts
git commit -m "test: catalogue domain queries — browse by Pokémon name"
```

---

## Task 5: API routes — browse by set

**Files:**
- Create: `app/api/cards/sets/route.ts`
- Create: `app/api/cards/browse/route.ts`

**Interfaces:**
- Consumes: `getSets`, `getCardsInSet` (Task 3), `guarded` (`lib/api.ts`), `getSession`/`requireStaff` (`lib/auth.ts`).
- Produces: `GET /api/cards/sets` → `{ sets: SetSummary[] }`; `GET /api/cards/browse?setName=X` → `{ cards: CatalogueRow[] }` — consumed by `CatalogueBrowser` (Task 7).

- [ ] **Step 1: Write the sets route**

Create `app/api/cards/sets/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getSets } from '@/lib/domain/catalogue'

export const GET = guarded(async () => {
  requireStaff(await getSession())
  return NextResponse.json({ sets: await getSets() })
})
```

- [ ] **Step 2: Write the browse-by-set route**

Create `app/api/cards/browse/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getCardsInSet } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const setName = req.nextUrl.searchParams.get('setName')
  if (!setName) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getCardsInSet(setName) })
})
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification against the dev server**

Run: `npm run dev` (separate terminal), then:
```bash
curl -s http://localhost:3000/api/cards/sets | head -c 300
```
Expected: either a `{"sets":[...]}` JSON body (if a staff session cookie is present) or a 401/redirect — either response confirms the route is wired and reachable (full auth-flow verification happens in Task 10's Playwright smoke test).

- [ ] **Step 5: Commit**

```bash
git add app/api/cards/sets/route.ts app/api/cards/browse/route.ts
git commit -m "feat: API routes for browsing the catalogue by set"
```

---

## Task 6: API routes — browse by Pokémon name

**Files:**
- Create: `app/api/cards/names/route.ts`
- Create: `app/api/cards/browse-by-name/route.ts`

**Interfaces:**
- Consumes: `getNames`, `getPrintingsByName` (Task 3/4).
- Produces: `GET /api/cards/names?q=` → `{ names: string[] }`; `GET /api/cards/browse-by-name?name=X` → `{ cards: CatalogueRow[] }` — consumed by `CatalogueBrowser` (Task 7).

- [ ] **Step 1: Write the names route**

Create `app/api/cards/names/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getNames } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  return NextResponse.json({ names: await getNames(q) })
})
```

- [ ] **Step 2: Write the browse-by-name route**

Create `app/api/cards/browse-by-name/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getPrintingsByName } from '@/lib/domain/catalogue'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const name = req.nextUrl.searchParams.get('name')
  if (!name) return NextResponse.json({ cards: [] })
  return NextResponse.json({ cards: await getPrintingsByName(name) })
})
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/cards/names/route.ts app/api/cards/browse-by-name/route.ts
git commit -m "feat: API routes for browsing the catalogue by Pokémon name"
```

---

## Task 7: Shared `CatalogueBrowser` component

**Files:**
- Create: `components/catalogue/CatalogueBrowser.tsx`

**Interfaces:**
- Consumes: `GET /api/cards/sets`, `/api/cards/browse`, `/api/cards/names`, `/api/cards/browse-by-name` (Tasks 5-6); `SetSummary`, `CatalogueRow` **types only** from `lib/domain/catalogue` (Task 3 — `import type`, erased at compile, so this does not pull `lib/db`/libsql into the client bundle per the repo's client-bundle boundary rule); `formatGBP` (`lib/pricing`); `Input` (`components/ui/input`), `Badge` (`components/ui/badge`).
- Produces: `CatalogueBrowser({ onSelectCard }: { onSelectCard: (selection: CatalogueRow) => void })` and re-exports `CatalogueRow` as `CatalogueSelection` — consumed by Task 8 (`/catalogue` page) and Task 9 (Buy page).

- [ ] **Step 1: Create the component**

Create `components/catalogue/CatalogueBrowser.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatGBP } from '@/lib/pricing'
import type { SetSummary, CatalogueRow } from '@/lib/domain/catalogue'

// Re-exported under a name that reads naturally at the call site ("the
// thing the user selected"), while reusing the domain module's shape.
export type CatalogueSelection = CatalogueRow

interface CatalogueBrowserProps {
  onSelectCard: (selection: CatalogueSelection) => void
}

type BrowseMode = 'set' | 'name'

export function CatalogueBrowser({ onSelectCard }: CatalogueBrowserProps) {
  const [mode, setMode] = useState<BrowseMode>('set')

  const [sets, setSets] = useState<SetSummary[]>([])
  const [setFilter, setSetFilter] = useState('')
  const [activeSet, setActiveSet] = useState<string | null>(null)

  const [nameQuery, setNameQuery] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)

  const [rows, setRows] = useState<CatalogueSelection[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (mode !== 'set' || sets.length > 0) return
    fetch('/api/cards/sets').then(r => r.json()).then(d => setSets(d.sets ?? []))
  }, [mode, sets.length])

  useEffect(() => {
    if (mode !== 'name') return
    const t = setTimeout(() => {
      fetch(`/api/cards/names?q=${encodeURIComponent(nameQuery)}`)
        .then(r => r.json()).then(d => setNames(d.names ?? []))
    }, 200)
    return () => clearTimeout(t)
  }, [mode, nameQuery])

  useEffect(() => {
    if (!activeSet) return
    setLoading(true)
    fetch(`/api/cards/browse?setName=${encodeURIComponent(activeSet)}`)
      .then(r => r.json()).then(d => setRows(d.cards ?? []))
      .finally(() => setLoading(false))
  }, [activeSet])

  useEffect(() => {
    if (!activeName) return
    setLoading(true)
    fetch(`/api/cards/browse-by-name?name=${encodeURIComponent(activeName)}`)
      .then(r => r.json()).then(d => setRows(d.cards ?? []))
      .finally(() => setLoading(false))
  }, [activeName])

  const filteredSets = sets.filter(s => s.setName.toLowerCase().includes(setFilter.toLowerCase()))
  const grouped = new Map<string, SetSummary[]>()
  for (const s of filteredSets) {
    const key = s.series ?? 'Other'
    grouped.set(key, [...(grouped.get(key) ?? []), s])
  }

  function switchMode(next: BrowseMode) {
    setMode(next)
    setActiveSet(null)
    setActiveName(null)
    setRows([])
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4 h-full min-h-0">
      <div className="flex flex-col gap-3 overflow-y-auto border-r pr-3">
        <div className="flex gap-1">
          <button
            type="button"
            className={`flex-1 px-2 py-1.5 rounded-lg text-sm font-medium ${mode === 'set' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => switchMode('set')}
          >
            By Set
          </button>
          <button
            type="button"
            className={`flex-1 px-2 py-1.5 rounded-lg text-sm font-medium ${mode === 'name' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => switchMode('name')}
          >
            By Pokémon
          </button>
        </div>

        {mode === 'set' ? (
          <>
            <Input placeholder="Filter sets…" value={setFilter} onChange={e => setSetFilter(e.target.value)} />
            {[...grouped.entries()].map(([era, group]) => (
              <div key={era}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-1">{era}</div>
                {group.map(s => (
                  <button
                    type="button"
                    key={s.setName}
                    onClick={() => setActiveSet(s.setName)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm ${activeSet === s.setName ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}`}
                  >
                    {s.setName} <span className="text-muted-foreground">({s.count})</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <Input placeholder="Type a Pokémon name…" value={nameQuery} onChange={e => setNameQuery(e.target.value)} autoFocus />
            {names.map(n => (
              <button
                type="button"
                key={n}
                onClick={() => setActiveName(n)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm ${activeName === n ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}`}
              >
                {n}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="overflow-y-auto">
        {loading && <p className="text-sm text-muted-foreground p-4">Loading…</p>}
        {!loading && rows.length === 0 && (activeSet || activeName) && (
          <p className="text-sm text-muted-foreground p-4">No cards found.</p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {rows.map(({ card, prices }) => (
            <button
              type="button"
              key={card.id}
              onClick={() => onSelectCard({ card, prices })}
              className="border rounded-lg p-2 text-left hover:border-primary transition-colors bg-card"
            >
              {card.imageUrl && (
                <Image src={card.imageUrl} alt={card.name} width={120} height={168} className="w-full h-auto rounded" />
              )}
              <p className="text-xs font-semibold mt-1 truncate">{card.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{card.setName} · #{card.setNumber}</p>
              {prices?.tcgplayerMarket != null && (
                <Badge variant="secondary" className="text-[10px] mt-1">{formatGBP(prices.tcgplayerMarket)}</Badge>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/catalogue/CatalogueBrowser.tsx
git commit -m "feat: shared CatalogueBrowser component"
```

---

## Task 8: Standalone Catalogue tab

**Files:**
- Create: `app/(app)/catalogue/page.tsx`
- Modify: `components/layout/Nav.tsx`

**Interfaces:**
- Consumes: `CatalogueBrowser`, `CatalogueSelection` (Task 7); `CardZoomModal`, `CardZoomData` (`components/shared/CardZoomModal.tsx`, unmodified).

- [ ] **Step 1: Create the page**

Create `app/(app)/catalogue/page.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { CatalogueBrowser, type CatalogueSelection } from '@/components/catalogue/CatalogueBrowser'
import { CardZoomModal, type CardZoomData } from '@/components/shared/CardZoomModal'

export default function CataloguePage() {
  const [zoomed, setZoomed] = useState<CardZoomData | null>(null)

  function handleSelect({ card, prices }: CatalogueSelection) {
    setZoomed({
      name: card.name,
      setName: card.setName,
      setNumber: card.setNumber,
      variant: card.variant,
      imageUrlLarge: card.imageUrlLarge,
      imageUrl: card.imageUrl,
      tcgplayerMarket: prices?.tcgplayerMarket ?? null,
      cardmarketTrend: prices?.cardmarketTrend ?? null,
    })
  }

  return (
    <div style={{ height: 'calc(100vh - 120px)' }}>
      <CardZoomModal card={zoomed} onClose={() => setZoomed(null)} />
      <CatalogueBrowser onSelectCard={handleSelect} />
    </div>
  )
}
```

- [ ] **Step 2: Add the nav entry**

In `components/layout/Nav.tsx`, add the `LibraryIcon` import and a new link between Buy and Customers:

```ts
import { ShoppingCartIcon, BanknoteIcon, LibraryIcon, UserIcon, StarIcon, PackageIcon, SearchIcon, BarChart3Icon, SettingsIcon, LockIcon } from 'lucide-react'
```

```ts
  const links = [
    { href: '/pos', label: 'POS', icon: ShoppingCartIcon },
    { href: '/buylist', label: 'Buy', icon: BanknoteIcon },
    { href: '/catalogue', label: 'Catalogue', icon: LibraryIcon },
    { href: '/customers', label: 'Customers', icon: UserIcon },
    { href: '/wants', label: 'Wants', icon: StarIcon },
    { href: '/inventory', label: 'Inventory', icon: PackageIcon },
    { href: '/prices', label: 'Prices', icon: SearchIcon },
    ...(staffRole === 'admin' ? [
      { href: '/reports', label: 'Reports', icon: BarChart3Icon },
      { href: '/settings', label: 'Settings', icon: SettingsIcon },
    ] : []),
  ]
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, log in as staff, click the new "Catalogue" tab. Expected: the By Set / By Pokémon toggle renders, selecting a set shows its card grid, and clicking a card opens the zoom modal with price badges.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/catalogue/page.tsx" components/layout/Nav.tsx
git commit -m "feat: standalone Catalogue browse tab"
```

---

## Task 9: Buy page — Search\|Browse toggle

**Files:**
- Modify: `app/(app)/buylist/page.tsx`

**Interfaces:**
- Consumes: `CatalogueBrowser`, `CatalogueSelection` (Task 7); existing `BuyCard`, `BuyCart`, `BuyCartLine` (unmodified).

- [ ] **Step 1: Add the mode toggle and Browse-mode rendering**

Replace the full contents of `app/(app)/buylist/page.tsx` with:

```tsx
'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BuyCard } from '@/components/buylist/BuyCard'
import { BuyCart, BuyCartLine } from '@/components/buylist/BuyCart'
import { CatalogueBrowser, type CatalogueSelection } from '@/components/catalogue/CatalogueBrowser'
import { toast } from 'sonner'
import type { Card, PriceCache } from '@/lib/db/schema'

interface SearchResult {
  card: Card
  prices: PriceCache | null
}

type PageMode = 'search' | 'browse'

export default function BuylistPage() {
  const [pageMode, setPageMode] = useState<PageMode>('search')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [cart, setCart] = useState<BuyCartLine[]>([])

  async function handleSearch() {
    const q = query.trim()
    if (!q) return
    setLoading(true)
    try {
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      const cards: Card[] = data.cards ?? []
      if (!cards.length) {
        toast.error(`No cards found for "${q}"`)
        setResults([])
        return
      }
      const slice = cards.slice(0, 10)
      const withPrices = await Promise.all(
        slice.map(async (card) => {
          try {
            const pr = await fetch(`/api/cards/${card.id}`)
            if (!pr.ok) return { card, prices: null }
            const d = await pr.json()
            return { card, prices: (d.priceCache ?? null) as PriceCache | null }
          } catch {
            return { card, prices: null }
          }
        })
      )
      setResults(withPrices)
    } catch {
      toast.error('Search failed — please try again')
    } finally {
      setLoading(false)
    }
  }

  function handleAdd(line: BuyCartLine) {
    setCart(prev => [...prev, line])
  }

  function handleBrowseSelect({ card, prices }: CatalogueSelection) {
    setResults(prev => prev.some(r => r.card.id === card.id) ? prev : [{ card, prices }, ...prev])
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Left: search/browse + results */}
      <div className="flex flex-col gap-4 overflow-y-auto min-h-0">
        <div className="flex gap-2 shrink-0">
          <Button variant={pageMode === 'search' ? 'default' : 'outline'} onClick={() => setPageMode('search')}>
            Search
          </Button>
          <Button variant={pageMode === 'browse' ? 'default' : 'outline'} onClick={() => setPageMode('browse')}>
            Browse
          </Button>
        </div>

        {pageMode === 'search' && (
          <div className="flex gap-2 shrink-0">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search card name to buy…"
              className="h-12 text-base"
              disabled={loading}
              autoFocus
            />
            <Button className="h-12 px-6" onClick={handleSearch} disabled={loading || !query.trim()}>
              Search
            </Button>
          </div>
        )}

        {pageMode === 'browse' && (
          <div className="shrink-0" style={{ height: '360px' }}>
            <CatalogueBrowser onSelectCard={handleBrowseSelect} />
          </div>
        )}

        {results.map(({ card, prices }) => (
          <BuyCard
            key={card.id}
            card={card}
            prices={prices}
            onAdd={line => handleAdd({ ...line, cardName: card.name })}
          />
        ))}
      </div>

      {/* Right: cart */}
      <div>
        <BuyCart
          lines={cart}
          onRemove={idx => setCart(prev => prev.filter((_, i) => i !== idx))}
          onClear={() => setCart([])}
        />
      </div>
    </div>
  )
}
```

Note: selecting a card in Browse mode prepends it to the same `results` array the Search tab renders via `BuyCard` — this is the "goes straight into the add-to-cart panel" behavior from the design spec, reusing `BuyCard`'s existing condition/quantity/add UI rather than building a second one.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, go to Buy, click "Browse", pick a set, click a card. Expected: a `BuyCard` panel for that card appears below the browser (condition selector, quantity, cash/credit offer, "Add to buy" button) — clicking "Add to buy" adds it to the cart on the right, identically to a search result.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/buylist/page.tsx"
git commit -m "feat: Search|Browse toggle on the Buy page"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including the 5 new/extended in `lib/domain/catalogue.test.ts` and the extended assertion in `lib/prices/sync.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds — this is the check that would have caught the client-bundle-boundary issue noted in `AGENTS.md` (a stray `lib/domain`/`lib/db` value-import from a client component breaks the build or dev server in a way `tsc`/`lint` don't always catch).

- [ ] **Step 5: Playwright smoke test**

Run: `npm run test:e2e`
Expected: the existing checkout smoke test still passes — this feature adds a new route and a Buy-page toggle but doesn't change the checkout flow the smoke test exercises, so a regression here would indicate an unintended side effect (e.g. a broken import breaking the whole app shell).

- [ ] **Step 6: Manual end-to-end walkthrough**

Run: `npm run dev`. As staff: (a) open `/catalogue`, browse By Set → pick "Base Set" (or whatever set the dev data has) → click a card → confirm the zoom modal shows price badges; (b) switch to By Pokémon → type a partial name → pick a result → confirm all printings show; (c) go to `/buylist` → Browse mode → pick a card → confirm it lands in the add-to-cart panel and can be added to the cart. If the dev catalogue has a card with multiple printings (e.g. the Snorlax case from the smoke test — Flashfire #80 / Generations #58), use it for step (b) since it's a good real-world "same name, multiple printings" case.

This is the final task — no commit (verification only, unless a fix was needed, in which case that fix gets its own commit before this task is marked complete).
