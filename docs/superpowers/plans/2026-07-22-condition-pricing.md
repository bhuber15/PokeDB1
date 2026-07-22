# Condition-Based Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-shop condition ladder (integer percent per NM/LP/MP/HP/DMG) that scales market price before margin/offer math on every market-derived price surface, owner-editable in Settings, defaulting to a no-op (all 100).

**Architecture:** The ladder lives as five integer columns on the single-row `settings` table, surfaced as `conditionSellPct: Record<Condition, number>` on `AppSettings`. All math goes through `lib/pricing.ts` (dependency-free, client-safe) so POS display and server-canonical `createSale` stay in lockstep and `expectedTotal` keeps matching. `calculateSellPrice`/`calculateBuyPrice` gain a condition-percent parameter — optional (default 100) during the migration tasks, flipped to **required** in the final wiring task so the compiler proves every call site made an explicit condition decision.

**Tech Stack:** Next.js App Router, Drizzle ORM (SQLite/Turso), zod, node:test via tsx, @testing-library/react for component tests.

**Spec:** `docs/superpowers/specs/2026-07-22-condition-pricing-design.md`

## Global Constraints

- All money is integer pence. Condition percents are integers 1–100. No floats in domain money math (the pre-existing float `marginMultiplier`/`buyCashPct` ratios stay as they are).
- Prices are server-canonical; the client never sends prices. `expectedTotal` must keep matching what the POS displayed.
- `lib/pricing.ts` must stay dependency-free and client-safe (no `lib/db` imports). Client components never value-import `lib/domain/*`.
- `sellPriceOverride` is absolute and wins over everything.
- Rounding order (fixed): `conditioned = max(1, round(market × pct / 100))`, then sell `ceil(conditioned × margin)` / buy `floor(conditioned × buyPct)`.
- DB defaults are all-100 (no-op): existing shops see zero price change until they edit the ladder. The recommended ladder (NM 100 / LP 85 / MP 70 / HP 50 / DMG 35) is a Settings preset button only.
- API routes use `guarded()` + `parseBody()`/zod for changed endpoints.
- Work in a worktree (superpowers:using-git-worktrees). Commit after every task. Do not merge — PR against main at the end.
- e2e note: in a fresh worktree the FIRST `npm run test:e2e` run is a throwaway cache-warmer (cold Turbopack; webServer can time out) — rerun warm before diagnosing failures.

---

### Task 1: Pricing core — conditions, ladder helpers, condition-aware price functions

**Files:**
- Modify: `lib/pricing.ts` (top of file, and `calculateSellPrice`/`calculateBuyPrice` at lines 1–20)
- Test: `lib/pricing.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `CONDITIONS: readonly ['NM','LP','MP','HP','DMG']`, `type Condition = typeof CONDITIONS[number]`
  - `type ConditionLadder = Record<Condition, number>`
  - `DEFAULT_CONDITION_LADDER: ConditionLadder` (all 100)
  - `RECOMMENDED_CONDITION_LADDER: ConditionLadder` (100/85/70/50/35)
  - `conditionPct(ladder: Record<string, number> | null | undefined, condition: string): number`
  - `applyConditionPct(marketPence: number, pct: number): number`
  - `calculateSellPrice(marketPence, overridePence, multiplier?, conditionPctArg = 100)`
  - `calculateBuyPrice(marketPence, pct, conditionPctArg = 100)`

- [ ] **Step 1: Write the failing tests** — append to `lib/pricing.test.ts` (extend the existing import line with the new names):

```ts
// --- Condition ladder ---

test('conditionPct: looks up a known condition', () => {
  const ladder = { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 }
  assert.equal(conditionPct(ladder, 'NM'), 100)
  assert.equal(conditionPct(ladder, 'DMG'), 35)
})

test('conditionPct: unknown condition, missing ladder, or invalid value → 100 (full market, today’s behavior)', () => {
  assert.equal(conditionPct({ NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 }, 'SEALED'), 100)
  assert.equal(conditionPct(null, 'LP'), 100)
  assert.equal(conditionPct(undefined, 'LP'), 100)
  assert.equal(conditionPct({ NM: 100, LP: 0, MP: 70, HP: 50, DMG: 35 }, 'LP'), 100)   // below range
  assert.equal(conditionPct({ NM: 100, LP: 170, MP: 70, HP: 50, DMG: 35 }, 'LP'), 100) // above range
  assert.equal(conditionPct({ NM: 100, LP: 85.5, MP: 70, HP: 50, DMG: 35 }, 'LP'), 100) // non-integer
})

test('applyConditionPct: integer rounding, and pct 100 is identity', () => {
  assert.equal(applyConditionPct(1000, 100), 1000)
  assert.equal(applyConditionPct(1000, 85), 850)
  assert.equal(applyConditionPct(999, 85), 849)  // round(849.15)
  assert.equal(applyConditionPct(999, 35), 350)  // round(349.65)
})

test('applyConditionPct: never rounds a real market price to £0.00', () => {
  assert.equal(applyConditionPct(1, 35), 1) // round(0.35) = 0 → clamped to 1p
})

test('calculateSellPrice: condition step before margin, ceil after', () => {
  // conditioned = round(1000 × 85/100) = 850; ceil(850 × 0.85) = ceil(722.5) = 723
  assert.equal(calculateSellPrice(1000, null, 0.85, 85), 723)
  // pct 100 reproduces the pre-feature value penny-exact
  assert.equal(calculateSellPrice(1000, null, 0.85, 100), calculateSellPrice(1000, null, 0.85))
})

test('calculateSellPrice: override wins over the ladder too', () => {
  assert.equal(calculateSellPrice(10000, 4200, 0.85, 35), 4200)
})

test('calculateBuyPrice: condition step before the buy fraction, floor after', () => {
  // conditioned = round(1000 × 70/100) = 700; floor(700 × 0.5) = 350
  assert.equal(calculateBuyPrice(1000, 0.5, 70), 350)
  assert.equal(calculateBuyPrice(1000, 0.5, 100), calculateBuyPrice(1000, 0.5))
  assert.equal(calculateBuyPrice(null, 0.5, 70), null)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern "condition"` (or plain `npm test` and look for the new tests)
Expected: FAIL — `conditionPct is not defined` / not exported.

- [ ] **Step 3: Implement in `lib/pricing.ts`** — add above `calculateSellPrice`, and change the two function signatures:

```ts
// Single source of truth for card conditions. buys.ts, BuyCard, and the CSV
// import route all key off this list; the DB stores the raw string.
export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const
export type Condition = (typeof CONDITIONS)[number]

// Integer percent of market price per condition (1–100). 100 across the
// board = condition pricing off (today's behavior).
export type ConditionLadder = Record<Condition, number>

export const DEFAULT_CONDITION_LADDER: ConditionLadder = { NM: 100, LP: 100, MP: 100, HP: 100, DMG: 100 }
// The Settings preset ("Use recommended ladder") — never a DB default.
export const RECOMMENDED_CONDITION_LADDER: ConditionLadder = { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 }

// Tolerant lookup: an unknown condition string or an out-of-range/non-integer
// value prices at full market (100) — bad data must never silently discount.
export function conditionPct(
  ladder: Record<string, number> | null | undefined,
  condition: string,
): number {
  const pct = ladder?.[condition]
  return pct != null && Number.isInteger(pct) && pct >= 1 && pct <= 100 ? pct : 100
}

// Condition-adjusted market price, integer pence. Clamped to ≥1p so a penny
// card can never round to a £0 price (0 would slip past createSale's == null
// NO_PRICE guard and sell for free).
export function applyConditionPct(marketPence: number, pct: number): number {
  return Math.max(1, Math.round(marketPence * pct / 100))
}
```

```ts
export function calculateSellPrice(
  marketPence: number | null | undefined,
  overridePence: number | null | undefined,
  multiplier = parseFloat(process.env.NEXT_PUBLIC_MARGIN_MULTIPLIER ?? '0.85') || 0.85,
  conditionPctArg = 100, // TODO(flip-to-required in final wiring task)
): number | null {
  if (overridePence != null) return overridePence
  if (marketPence == null) return null
  return Math.ceil(applyConditionPct(marketPence, conditionPctArg) * multiplier)
}
```

```ts
// Buy-in offer = condition-adjusted market pence × percentage, floored so we
// never overpay by a rounding penny.
export function calculateBuyPrice(
  marketPence: number | null | undefined,
  pct: number,
  conditionPctArg = 100, // TODO(flip-to-required in final wiring task)
): number | null {
  if (marketPence == null) return null
  return Math.floor(applyConditionPct(marketPence, conditionPctArg) * pct)
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (all existing pricing tests still pass — pct 100 is an exact identity for integer pence inputs).

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.ts lib/pricing.test.ts
git commit -m "Pricing core: condition ladder types + condition-aware sell/buy math"
```

---

### Task 2: Settings storage — schema columns, migration, AppSettings record, provider fallback

**Files:**
- Modify: `lib/db/schema.ts` (settings table, line ~145)
- Modify: `lib/settings.ts`
- Modify: `components/shared/SettingsProvider.tsx`
- Create: `lib/db/migrations/0021_*.sql` (generated — do not hand-write)
- Test: `lib/settings.test.ts`

**Interfaces:**
- Consumes: `ConditionLadder`, `DEFAULT_CONDITION_LADDER` from `@/lib/pricing`.
- Produces: `AppSettings.conditionSellPct: ConditionLadder`; settings columns `condSellPctNm|Lp|Mp|Hp|Dmg` (`cond_sell_pct_nm` … int NOT NULL DEFAULT 100); `updateSettings` accepts `conditionSellPct` in its patch.

- [ ] **Step 1: Write the failing test** — append to `lib/settings.test.ts`:

```ts
test('condition ladder: defaults to all-100 and round-trips through updateSettings', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const before = await getSettings(dbc)
  assert.deepEqual(before.conditionSellPct, { NM: 100, LP: 100, MP: 100, HP: 100, DMG: 100 })

  const after = await updateSettings(
    { conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  assert.deepEqual(after.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })

  // Persisted, not just echoed
  const reread = await getSettings(dbc)
  assert.deepEqual(reread.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })

  // A ladder-less patch leaves the ladder untouched
  const patched = await updateSettings({ shopName: 'Cardtill' }, dbc)
  assert.deepEqual(patched.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })
})
```

Add `updateSettings` to the import from `./settings`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `conditionSellPct` undefined on settings.

- [ ] **Step 3: Schema columns** — in `lib/db/schema.ts` settings table, after `marginNoCostHandling`:

```ts
  // Condition ladder: integer % of market price per condition (1–100).
  // 100 across the board = condition pricing off. Shared by sell prices,
  // buylist offers, and the buylist overpayment cap.
  condSellPctNm: integer('cond_sell_pct_nm').notNull().default(100),
  condSellPctLp: integer('cond_sell_pct_lp').notNull().default(100),
  condSellPctMp: integer('cond_sell_pct_mp').notNull().default(100),
  condSellPctHp: integer('cond_sell_pct_hp').notNull().default(100),
  condSellPctDmg: integer('cond_sell_pct_dmg').notNull().default(100),
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: new `lib/db/migrations/0021_<slug>.sql` containing five `ALTER TABLE \`settings\` ADD \`cond_sell_pct_*\` integer DEFAULT 100 NOT NULL;` statements (plus journal update). Inspect the file to confirm — no other statements.

- [ ] **Step 5: lib/settings.ts** — thread the record through:

```ts
import { type ConditionLadder, DEFAULT_CONDITION_LADDER, parsePounds } from '@/lib/pricing'
```

`AppSettings` gains:

```ts
  conditionSellPct: ConditionLadder
```

`DEFAULT_SETTINGS` gains:

```ts
  conditionSellPct: { ...DEFAULT_CONDITION_LADDER },
```

`toAppSettings` gains:

```ts
    conditionSellPct: {
      NM: row.condSellPctNm, LP: row.condSellPctLp, MP: row.condSellPctMp,
      HP: row.condSellPctHp, DMG: row.condSellPctDmg,
    },
```

`updateSettings` — the record is not a column, so map it (replace the body's `.set()` call):

```ts
export async function updateSettings(patch: Partial<AppSettings>, dbc: Db = db): Promise<AppSettings> {
  await getSettings(dbc) // ensure the row exists
  const { conditionSellPct, ...columns } = patch
  const ladderCols = conditionSellPct ? {
    condSellPctNm: conditionSellPct.NM, condSellPctLp: conditionSellPct.LP,
    condSellPctMp: conditionSellPct.MP, condSellPctHp: conditionSellPct.HP,
    condSellPctDmg: conditionSellPct.DMG,
  } : {}
  const [updated] = await dbc.update(settings)
    .set({ ...columns, ...ladderCols, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    .where(eq(settings.id, 1))
    .returning()
  return toAppSettings(updated)
}
```

- [ ] **Step 6: SettingsProvider fallback** — in `components/shared/SettingsProvider.tsx`, the hand-written fallback object (it cannot import `lib/settings` — that pulls `lib/db` into the client bundle; importing from `lib/pricing` is safe):

```ts
import { DEFAULT_CONDITION_LADDER } from '@/lib/pricing'
```

and in the fallback object add:

```ts
conditionSellPct: { ...DEFAULT_CONDITION_LADDER },
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS — including `settings never exposes ownerPasswordHash` and the broken-DB default tests (`DEFAULT_SETTINGS` deepEqual now includes the ladder).

- [ ] **Step 8: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations lib/settings.ts lib/settings.test.ts components/shared/SettingsProvider.tsx
git commit -m "Settings: condition ladder columns (default 100 = no-op) + AppSettings record"
```

---

### Task 3: Settings PATCH — zod schema + route migration to parseBody

**Files:**
- Modify: `lib/settings.ts` (add `settingsPatchSchema` + zod import)
- Modify: `app/api/settings/route.ts` (replace hand-rolled validation)
- Test: `lib/settings.test.ts`

**Interfaces:**
- Consumes: `conditionLadderSchema` concept from spec; `parseBody` from `@/lib/validation` (throws `DomainError('INVALID_INPUT')` → `guarded()` maps to 400 `{ error }`).
- Produces: `settingsPatchSchema` exported from `@/lib/settings` — parses to `Partial<AppSettings>`-compatible patch; the PATCH route body contract now also accepts `conditionSellPct` (full five-key record, ints 1–100; partial records rejected).

- [ ] **Step 1: Write the failing tests** — append to `lib/settings.test.ts` (add `settingsPatchSchema` to the import):

```ts
test('settingsPatchSchema: accepts a full 1–100 integer ladder', () => {
  const r = settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } })
  assert.ok(r.success)
})

test('settingsPatchSchema: rejects partial ladders, out-of-range and non-integer values', () => {
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 85 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 0, MP: 70, HP: 50, DMG: 35 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 101, LP: 85, MP: 70, HP: 50, DMG: 35 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 99.5, LP: 85, MP: 70, HP: 50, DMG: 35 } }).success)
})

test('settingsPatchSchema: preserves the existing route semantics', () => {
  // valid single-field patches
  assert.ok(settingsPatchSchema.safeParse({ marginMultiplier: 0.9 }).success)
  assert.ok(settingsPatchSchema.safeParse({ buyCreditPct: 1 }).success)
  assert.ok(settingsPatchSchema.safeParse({ vatScheme: 'margin' }).success)
  // invalid values that the old route 400'd on
  assert.ok(!settingsPatchSchema.safeParse({ marginMultiplier: 0 }).success)
  assert.ok(!settingsPatchSchema.safeParse({ buyCashPct: 1.5 }).success)
  assert.ok(!settingsPatchSchema.safeParse({ primaryPriceSource: 'ebay' }).success)
  // empty patch → refine failure (was "No valid fields to update")
  assert.ok(!settingsPatchSchema.safeParse({}).success)
  // unknown keys are stripped, and a patch of ONLY unknown keys is empty → rejected
  assert.ok(!settingsPatchSchema.safeParse({ bogus: 1 }).success)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `settingsPatchSchema` not exported.

- [ ] **Step 3: Implement the schema** in `lib/settings.ts` (`import { z } from 'zod'`):

```ts
const pctInt = z.number().int().min(1).max(100)
const conditionLadderSchema = z.object({ NM: pctInt, LP: pctInt, MP: pctInt, HP: pctInt, DMG: pctInt })

// Body contract for PATCH /api/settings. Mirrors the old hand-rolled checks:
// positive finite rates, (0,1] buy fractions, enum fields, 60-char shop name;
// unknown keys are stripped; at least one recognised field required.
export const settingsPatchSchema = z.object({
  shopName: z.string().trim().min(1).max(60),
  usdToGbp: z.number().finite().positive(),
  eurToGbp: z.number().finite().positive(),
  marginMultiplier: z.number().finite().positive(),
  highValueThreshold: z.number().int().positive(), // pence
  primaryPriceSource: z.enum(['cardmarket', 'tcgplayer']),
  vatScheme: z.enum(['none', 'standard', 'margin']),
  marginNoCostHandling: z.enum(['exclude', 'block']),
  buyCashPct: z.number().positive().max(1),
  buyCreditPct: z.number().positive().max(1),
  conditionSellPct: conditionLadderSchema,
}).partial().refine(o => Object.keys(o).length > 0, { message: 'No valid fields to update' })
```

- [ ] **Step 4: Run tests** — `npm test`, expected PASS.

- [ ] **Step 5: Migrate the route** — replace the whole body of `app/api/settings/route.ts` PATCH with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getSettings, updateSettings, settingsPatchSchema } from '@/lib/settings'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getSettings(db))
})

export const PATCH = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  // Only admins can change shop settings
  requireAdmin(await getSession(await currentTenantId()))
  const patch = await parseBody(req, settingsPatchSchema)
  return NextResponse.json(await updateSettings(patch, db))
})
```

Behavior notes (intended, small tightenings): invalid-typed fields now 400 instead of being silently ignored; error text is zod's (`"marginMultiplier: …"`) — SettingsForm shows `err.error` so toasts still work.

- [ ] **Step 6: Run tests + lint**

Run: `npm test && npm run lint`
Expected: PASS (tenancy-guard test still sees `getTenantDb()` in the route).

- [ ] **Step 7: Commit**

```bash
git add lib/settings.ts lib/settings.test.ts app/api/settings/route.ts
git commit -m "Settings API: zod patch schema (incl. condition ladder), route on parseBody"
```

---

### Task 4: createSale — server-canonical condition pricing

**Files:**
- Modify: `lib/domain/sales.ts` (line ~91)
- Test: `lib/domain/sales.test.ts`

**Interfaces:**
- Consumes: `conditionPct` from `@/lib/pricing`; `settings.conditionSellPct`; `updateSettings` from `@/lib/settings` (test setup).
- Produces: createSale prices every line at `calculateSellPrice(market, override, margin, conditionPct(ladder, item.condition))`.

- [ ] **Step 1: Write the failing tests** — append to `lib/domain/sales.test.ts` (import `updateSettings` from `../settings`):

```ts
// --- Condition-based pricing ---

test('condition ladder scales the sell price (LP 85%: conditioned market, then margin ceil)', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  // LP item for the same card: conditioned = round(1000×0.85) = 850; ceil(850×0.85) = 723
  await dbc.insert(schema.inventoryItems).values({
    id: 2, cardId: 1, condition: 'LP', quantity: 3, costPrice: 200, qrCode: 'qr-2',
  })
  const { total } = await createSale({
    ...base, items: [{ inventoryItemId: 2, quantity: 1 }], expectedTotal: 723,
  }, dbc)
  assert.equal(total, 723)
})

test('condition ladder: NM stays at full market; default all-100 ladder is a byte-exact no-op', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  const { total } = await createSale(base, dbc) // NM item, 2 × ceil(1000×0.85) = 1700
  assert.equal(total, 1700)
})

test('condition ladder: override still beats the ladder', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  await dbc.insert(schema.inventoryItems).values({
    id: 3, cardId: 1, condition: 'DMG', quantity: 1, costPrice: 100, sellPriceOverride: 1200, qrCode: 'qr-3',
  })
  const { total } = await createSale({
    ...base, items: [{ inventoryItemId: 3, quantity: 1 }], expectedTotal: 1200,
  }, dbc)
  assert.equal(total, 1200)
})

test('condition ladder: a stale client expectedTotal still throws PRICE_CHANGED', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  await dbc.insert(schema.inventoryItems).values({
    id: 4, cardId: 1, condition: 'MP', quantity: 1, costPrice: 100, qrCode: 'qr-4',
  })
  // Client displayed the un-conditioned 850; server now computes ceil(700×0.85) = 595
  await assert.rejects(
    () => createSale({ ...base, items: [{ inventoryItemId: 4, quantity: 1 }], expectedTotal: 850 }, dbc),
    domainCode('PRICE_CHANGED'),
  )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: the LP test FAILS with PRICE_CHANGED (server still prices LP at 850×margin → 723 expected vs computed 850-based total) — precisely the bug being fixed.

- [ ] **Step 3: Implement** — in `lib/domain/sales.ts`, extend the pricing import and the `unitPrice` call:

```ts
import { calculateSellPrice, conditionPct, pickMarketPrice, computeSaleTotals, computeMarginVat } from '@/lib/pricing'
```

```ts
    const unitPrice = calculateSellPrice(
      pickMarketPrice(row.prices, settings.primaryPriceSource),
      row.item.sellPriceOverride,
      settings.marginMultiplier,
      conditionPct(settings.conditionSellPct, row.item.condition),
    )
```

- [ ] **Step 4: Run tests** — `npm test`, expected PASS (all pre-existing sales tests unchanged — default ladder is a no-op).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/sales.ts lib/domain/sales.test.ts
git commit -m "createSale: condition ladder scales market before margin (server-canonical)"
```

---

### Task 5: createBuy — overpayment cap against the conditioned market

**Files:**
- Modify: `lib/domain/buys.ts`
- Test: `lib/domain/buys.test.ts`

**Interfaces:**
- Consumes: `applyConditionPct`, `conditionPct`, `CONDITIONS` from `@/lib/pricing`; full `settings` (not just `primaryPriceSource`).
- Produces: non-admin cap = `payPrice × 10 > conditioned × 11` per line; `maxPay = floor(conditioned × 11 / 10)`; error detail `market` field carries the conditioned reference. `marketAtBuy` stays raw.

- [ ] **Step 1: Write the failing tests** — append to `lib/domain/buys.test.ts` (import `updateSettings` from `../settings`; reuse the file's existing seed/fixture helpers — read the top of the file first and follow its patterns):

```ts
// --- Condition-aware overpayment cap ---

test('staff cap tightens to 110% of the conditioned market (DMG 35%)', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  // market 1000p; DMG conditioned = 350p; cap = floor(350×11/10) = 385p.
  // 400p would have passed the old raw-market cap (≤1100) — must now be rejected.
  await assert.rejects(
    () => createBuy({
      staffId: 1, staffRole: 'staff', method: 'cash',
      items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 400 }],
    }, dbc),
    domainCode('BUY_CAP_EXCEEDED'),
  )
  // At the conditioned cap exactly → accepted; marketAtBuy stays RAW market.
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 385 }],
  }, dbc)
  const items = await dbc.select().from(schema.buyItems).where(eq(schema.buyItems.buyId, buyId))
  assert.equal(items[0].marketAtBuy, 1000)
})

test('default all-100 ladder leaves the cap at 110% of raw market (no-op)', async () => {
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'staff', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 1100 }],
  }, dbc)
  assert.ok(buyId)
})

test('admin bypasses the conditioned cap too', async () => {
  await updateSettings({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  const { buyId } = await createBuy({
    staffId: 1, staffRole: 'admin', method: 'cash',
    items: [{ cardId: 1, condition: 'DMG', quantity: 1, payPrice: 900 }],
  }, dbc)
  assert.ok(buyId)
})
```

Adjust fixture ids/prices to the file's existing seed (card 1 with `cardmarketTrend: 1000` is the established pattern — verify at the top of the file and reuse its helpers).

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: first test FAILS (400p passes the old raw cap).

- [ ] **Step 3: Implement** — in `lib/domain/buys.ts`:

Replace the local conditions set with the shared list:

```ts
import { pickMarketPrice, applyConditionPct, conditionPct, CONDITIONS } from '@/lib/pricing'
```

```ts
const CONDITION_SET = new Set<string>(CONDITIONS)
```

(and use `CONDITION_SET.has(it.condition)` in validation). Take full settings and condition the cap:

```ts
  const settings = await getSettings(dbc)
  const marketByCard = new Map<number, number | null>(
    cardIds.map(id => [id, pickMarketPrice(cacheRows.find(r => r.cardId === id), settings.primaryPriceSource)]),
  )
  for (const it of input.items) {
    const market = marketByCard.get(it.cardId) ?? null
    // The cap protects against overpaying for the card AS GRADED — reference
    // is the condition-adjusted market, not raw NM market.
    const conditioned = market !== null
      ? applyConditionPct(market, conditionPct(settings.conditionSellPct, it.condition))
      : null
    if (
      input.staffRole !== 'admin' && conditioned !== null
      && it.payPrice * BUY_CAP_DENOMINATOR > conditioned * BUY_CAP_NUMERATOR
    ) {
      const maxPay = Math.floor(conditioned * BUY_CAP_NUMERATOR / BUY_CAP_DENOMINATOR)
      throw new DomainError(
        'BUY_CAP_EXCEEDED',
        `Pay price is above 110% of market for this condition — max £${(maxPay / 100).toFixed(2)} for this card. An admin can override.`,
        { cardId: it.cardId, payPrice: it.payPrice, market: conditioned, maxPay },
      )
    }
  }
```

`marketAtBuy` insert stays `marketByCard.get(it.cardId) ?? null` (raw). Before committing, run `grep -rn "BUY_CAP_EXCEEDED" components/ app/` and confirm no client code parses the error `market` detail field (expected: toast of `message` only) — if something does, keep its display coherent.

- [ ] **Step 4: Run tests** — `npm test`, expected PASS (existing cap tests unchanged: default ladder no-op).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/buys.ts lib/domain/buys.test.ts
git commit -m "createBuy: overpayment cap references the conditioned market"
```

---

### Task 6: Server sell surfaces — batch labels + inventory CSV sell_price column

**Files:**
- Modify: `app/api/labels/batch/route.ts` (line ~37)
- Modify: `app/api/inventory/export/route.ts`

**Interfaces:**
- Consumes: `conditionPct` from `@/lib/pricing`; `settings.conditionSellPct`.
- Produces: labels priced per condition; inventory CSV gains a final `sell_price` column (pounds 2 dp, blank when no price) — computed identically to the POS. CSV import ignores unknown columns (verified: it reads columns by header name), so round-trip is safe.

- [ ] **Step 1: labels/batch** — extend the import and the sellPrice call:

```ts
import { calculateSellPrice, conditionPct, pickMarketPrice } from '@/lib/pricing'
```

```ts
    sellPrice: calculateSellPrice(
      pickMarketPrice(prices, settings.primaryPriceSource),
      item.sellPriceOverride,
      settings.marginMultiplier,
      conditionPct(settings.conditionSellPct, item.condition),
    ),
```

- [ ] **Step 2: inventory export** — add the priceCache join, settings, and the trailing column:

```ts
import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { inventoryItems, cards, priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { toCSV } from '@/lib/csv'
import { getSettings } from '@/lib/settings'
import { calculateSellPrice, conditionPct, pickMarketPrice } from '@/lib/pricing'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))

  const settings = await getSettings(db)
  const rows = await db.select({ item: inventoryItems, card: cards, prices: priceCache })
    .from(inventoryItems)
    .innerJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(priceCache, eq(priceCache.cardId, inventoryItems.cardId))
    .where(eq(inventoryItems.isActive, true))

  const csv = toCSV(
    ['inventory_id', 'external_id', 'name', 'set_name', 'set_number', 'condition', 'quantity', 'cost_price', 'sell_price_override', 'location', 'defect_notes', 'sell_price'],
    rows.map(({ item, card, prices }) => {
      // Same computation as the POS/labels: override, else conditioned market × margin.
      const sellPrice = calculateSellPrice(
        pickMarketPrice(prices, settings.primaryPriceSource),
        item.sellPriceOverride,
        settings.marginMultiplier,
        conditionPct(settings.conditionSellPct, item.condition),
      )
      return [
        item.id, card.externalId ?? '', card.name, card.setName, card.setNumber,
        // CSV money columns are pounds (human-facing, opened in Excel) — bare
        // numbers, not formatGBP, so the column stays numeric
        item.condition, item.quantity, item.costPrice != null ? (item.costPrice / 100).toFixed(2) : '',
        item.sellPriceOverride != null ? (item.sellPriceOverride / 100).toFixed(2) : '',
        item.location ?? '', item.defectNotes ?? '',
        sellPrice != null ? (sellPrice / 100).toFixed(2) : '',
      ]
    }),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
    },
  })
})
```

(`sell_price` goes LAST so existing spreadsheet consumers keep their column positions.)

- [ ] **Step 3: Run** — `npm test && npm run lint`, expected PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/labels/batch/route.ts app/api/inventory/export/route.ts
git commit -m "Labels + inventory CSV: condition-aware sell prices (new sell_price column)"
```

---

### Task 7: Client sell surfaces — POS CardResult, InventoryTable, QR modal

**Files:**
- Modify: `components/pos/CardResult.tsx` (lines ~33–41)
- Modify: `components/inventory/InventoryTable.tsx` (line ~193)
- Modify: `app/(app)/inventory/page.tsx` (lines ~17, 56–63)

**Interfaces:**
- Consumes: `conditionPct` from `@/lib/pricing`; `conditionSellPct` from `useSettings()`.
- Produces: every client-displayed sell price carries the item's condition — matching the server so `expectedTotal` agrees.

- [ ] **Step 1: CardResult** — add `conditionSellPct` to the destructure and the call:

```ts
  const { marginMultiplier, primaryPriceSource, conditionSellPct } = useSettings()
```

```ts
  const sellPrice = selected
    ? calculateSellPrice(
        pickMarketPrice(prices, primaryPriceSource),
        selected.sellPriceOverride,
        marginMultiplier,
        conditionPct(conditionSellPct, selected.condition),
      )
    : null
```

(import `conditionPct` from `@/lib/pricing`). The price the POS displays per condition button now updates when the staff switches condition — and it's the price passed to `onAddToCart`, keeping the cart line and `expectedTotal` consistent.

- [ ] **Step 2: InventoryTable** — same treatment at the group row (groups are per card+condition; `group.condition` exists):

```ts
              const sellPrice = calculateSellPrice(
                pickMarketPrice(prices, primaryPriceSource),
                group.items[0].item.sellPriceOverride,
                marginMultiplier,
                conditionPct(conditionSellPct, group.condition),
              )
```

with `conditionSellPct` added to the component's `useSettings()` destructure and `conditionPct` imported from `@/lib/pricing`.

- [ ] **Step 3: inventory/page.tsx QR modal** — same:

```ts
  const { primaryPriceSource, marginMultiplier, conditionSellPct } = useSettings()
```

```ts
        sellPrice: formatGBP(calculateSellPrice(
          pickMarketPrice(row.prices, primaryPriceSource),
          row.item.sellPriceOverride,
          marginMultiplier,
          conditionPct(conditionSellPct, row.item.condition),
        )),
```

- [ ] **Step 4: Run** — `npm test && npm run lint`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add components/pos/CardResult.tsx components/inventory/InventoryTable.tsx "app/(app)/inventory/page.tsx"
git commit -m "POS + inventory displays: condition-aware sell prices"
```

---

### Task 8: BuyCard — offers react to the condition selector (+ component test)

**Files:**
- Modify: `components/buylist/BuyCard.tsx`
- Create: `components/buylist/BuyCard.test.tsx`

**Interfaces:**
- Consumes: `CONDITIONS`, `Condition`, `conditionPct` from `@/lib/pricing`; `conditionSellPct` from `useSettings()`.
- Produces: cash/credit offer badges, the summary line, and the `payPriceCash`/`payPriceCredit` in `onAdd`'s `BuyLineInput` all reflect the selected condition. The raw Market badge stays raw.

- [ ] **Step 1: Write the failing component test** — `components/buylist/BuyCard.test.tsx` (follow the `WantsPanel.test.tsx` pattern):

```tsx
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BuyCard, type BuyLineInput } from './BuyCard'
import { SettingsProvider } from '@/components/shared/SettingsProvider'
import { DEFAULT_CONDITION_LADDER, RECOMMENDED_CONDITION_LADDER } from '@/lib/pricing'
import type { AppSettings } from '@/lib/settings'
import type { Card, PriceCache } from '@/lib/db/schema'

afterEach(cleanup)

const settings = (ladder: AppSettings['conditionSellPct']): AppSettings => ({
  shopName: 'Test', usdToGbp: 0.79, eurToGbp: 0.86, marginMultiplier: 0.85,
  highValueThreshold: 5000, buyCashPct: 0.5, buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket', vatScheme: 'none', marginNoCostHandling: 'exclude',
  conditionSellPct: ladder,
})

// Minimal fixtures — no image URLs so next/image never renders in the test DOM.
const card = { id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102', variant: null, imageUrl: null, imageUrlLarge: null } as unknown as Card
const prices = { cardId: 1, cardmarketTrend: 1000, tcgplayerMarket: null } as unknown as PriceCache

function renderBuyCard(ladder: AppSettings['conditionSellPct'], onAdd: (l: BuyLineInput) => void = () => {}) {
  return render(
    <SettingsProvider value={settings(ladder)}>
      <BuyCard card={card} prices={prices} onAdd={onAdd} />
    </SettingsProvider>,
  )
}

test('offers scale with the selected condition (MP 70%: cash floor(700×0.5) = £3.50)', () => {
  renderBuyCard(RECOMMENDED_CONDITION_LADDER)
  assert.ok(screen.getByText('Cash £5.00')) // NM default
  fireEvent.click(screen.getByRole('button', { name: 'MP' }))
  assert.ok(screen.getByText('Cash £3.50'))
  assert.ok(screen.getByText('Credit £4.55')) // floor(700×0.65)
  assert.ok(screen.getByText('Market £10.00')) // raw market badge unchanged
})

test('all-100 ladder: offers identical for every condition (no-op default)', () => {
  renderBuyCard({ ...DEFAULT_CONDITION_LADDER })
  fireEvent.click(screen.getByRole('button', { name: 'DMG' }))
  assert.ok(screen.getByText('Cash £5.00'))
})

test('Add to buy sends condition-adjusted pay prices', () => {
  let added: BuyLineInput | null = null
  renderBuyCard(RECOMMENDED_CONDITION_LADDER, l => { added = l })
  fireEvent.click(screen.getByRole('button', { name: 'HP' })) // conditioned = 500
  fireEvent.click(screen.getByRole('button', { name: 'Add to buy' }))
  assert.deepEqual(added, { cardId: 1, condition: 'HP', quantity: 1, payPriceCash: 250, payPriceCredit: 325 })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cash £3.50` not found after selecting MP (offers are condition-blind).

- [ ] **Step 3: Implement** — in `components/buylist/BuyCard.tsx`: delete the local `CONDITIONS`/`Condition` definitions, import the shared ones, and condition the offers:

```ts
import { calculateBuyPrice, conditionPct, formatGBP, pickMarketPrice, pickMarketSource, CONDITIONS, type Condition } from '@/lib/pricing'
```

```ts
  const { buyCashPct, buyCreditPct, primaryPriceSource, conditionSellPct } = useSettings()

  const market = pickMarketPrice(prices, primaryPriceSource)
  // Offers are quoted for the card AS GRADED: conditioned market × buy %.
  const condPct = conditionPct(conditionSellPct, condition)
  const cashOffer = calculateBuyPrice(market, buyCashPct, condPct)
  const creditOffer = calculateBuyPrice(market, buyCreditPct, condPct)
```

Everything downstream (badges, summary line, `onAdd` payload) already reads `cashOffer`/`creditOffer`, so it follows automatically.

- [ ] **Step 4: Run tests** — `npm test`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add components/buylist/BuyCard.tsx components/buylist/BuyCard.test.tsx
git commit -m "Buylist offers: condition-aware quotes reacting to the condition selector"
```

---

### Task 9: SettingsForm — Condition pricing card (editable ladder + recommended preset)

**Files:**
- Modify: `components/settings/SettingsForm.tsx`

**Interfaces:**
- Consumes: `CONDITIONS`, `Condition`, `RECOMMENDED_CONDITION_LADDER`, `conditionPct` from `@/lib/pricing`; `current.conditionSellPct`.
- Produces: PATCH body gains `conditionSellPct: { NM, LP, MP, HP, DMG }` (integers).

- [ ] **Step 1: State + payload** — add to the imports:

```ts
import { formatGBP, parsePounds, usdToGbp as usdToGbpPence, eurToGbp as eurToGbpPence, calculateSellPrice, calculateBuyPrice, CONDITIONS, RECOMMENDED_CONDITION_LADDER, type Condition } from '@/lib/pricing'
```

State (near the other useState calls):

```ts
  const [condPct, setCondPct] = useState<Record<Condition, string>>({
    NM: String(current.conditionSellPct.NM), LP: String(current.conditionSellPct.LP),
    MP: String(current.conditionSellPct.MP), HP: String(current.conditionSellPct.HP),
    DMG: String(current.conditionSellPct.DMG),
  })
```

In the `save()` body JSON add:

```ts
          conditionSellPct: {
            NM: parseInt(condPct.NM), LP: parseInt(condPct.LP), MP: parseInt(condPct.MP),
            HP: parseInt(condPct.HP), DMG: parseInt(condPct.DMG),
          },
```

(An out-of-range or non-numeric input comes back as a clear 400 toast from the zod schema; inputs also carry `min={1} max={100}`.)

- [ ] **Step 2: Existing generic examples pass literal 100** (they are NM-reference examples by intent):

```ts
  const exampleSell = calculateSellPrice(exampleGbp, null, margin, 100)
  const exampleCmSell = calculateSellPrice(exampleCmGbp, null, margin, 100)
  const cashExample = calculateBuyPrice(TEN_POUNDS, parseFloat(buyCashPct) || 0, 100)
  const creditExample = calculateBuyPrice(TEN_POUNDS, parseFloat(buyCreditPct) || 0, 100)
```

- [ ] **Step 3: The card** — insert this section between the Pricing section and the Buylist Rates section:

```tsx
      {/* Condition pricing */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Condition Pricing</h2>
        <p className="text-xs text-muted-foreground">
          Percent of market price each condition sells at, applied before the margin multiplier.
          Also scales buylist offers. 100 across the board = condition pricing off.
          Manual price overrides always win.
        </p>

        <div className="grid grid-cols-5 gap-2">
          {CONDITIONS.map(c => (
            <div key={c} className="space-y-1.5">
              <Label htmlFor={`settings-cond-${c}`}>{c} %</Label>
              <Input
                id={`settings-cond-${c}`} name={`condPct${c}`} type="number" inputMode="numeric"
                step="1" min={1} max={100} value={condPct[c]}
                onChange={e => setCondPct(prev => ({ ...prev, [c]: e.target.value }))}
              />
            </div>
          ))}
        </div>

        <Button
          type="button" variant="outline" className="w-full"
          onClick={() => setCondPct({
            NM: String(RECOMMENDED_CONDITION_LADDER.NM), LP: String(RECOMMENDED_CONDITION_LADDER.LP),
            MP: String(RECOMMENDED_CONDITION_LADDER.MP), HP: String(RECOMMENDED_CONDITION_LADDER.HP),
            DMG: String(RECOMMENDED_CONDITION_LADDER.DMG),
          })}
        >
          Use recommended ladder (100 / 85 / 70 / 50 / 35)
        </Button>

        {/* Live worked example */}
        <div className="bg-muted/30 rounded-lg p-3 text-sm space-y-1">
          <div className="text-xs text-muted-foreground mb-1">Worked example — a card with a £10.00 market price sells for:</div>
          {CONDITIONS.map(c => (
            <div key={c} className="flex justify-between">
              <span className="text-muted-foreground">{c}</span>
              <span className="font-medium">
                {formatGBP(calculateSellPrice(1000, null, margin, parseInt(condPct[c]) >= 1 && parseInt(condPct[c]) <= 100 ? parseInt(condPct[c]) : 100))}
              </span>
            </div>
          ))}
        </div>
      </section>
```

- [ ] **Step 4: Run** — `npm test && npm run lint`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add components/settings/SettingsForm.tsx
git commit -m "Settings UI: condition pricing card with editable ladder + recommended preset"
```

---

### Task 10: Flip conditionPct to required — compiler-checked completeness

**Files:**
- Modify: `lib/pricing.ts` (the two signatures)
- Modify: `app/api/inventory/import/route.ts` (CONDITIONS consolidation)

**Interfaces:**
- Produces: `calculateSellPrice(marketPence, overridePence, multiplier, conditionPctArg)` and `calculateBuyPrice(marketPence, pct, conditionPctArg)` with **required** condition params. Any call site not passing a condition percent is now a compile error.

- [ ] **Step 1: Flip** — in `lib/pricing.ts` change the two parameters from `conditionPctArg = 100` to `conditionPctArg: number` and drop the `// TODO(flip-to-required…)` comments. Keep the `multiplier` default as is.

- [ ] **Step 2: Consolidate the last CONDITIONS duplicate** — in `app/api/inventory/import/route.ts` replace the local `const CONDITIONS = new Set([...])` with:

```ts
import { parsePounds, CONDITIONS } from '@/lib/pricing'

const CONDITION_SET = new Set<string>(CONDITIONS)
```

(and use `CONDITION_SET.has(condition)`).

- [ ] **Step 3: Update any test call sites** that still call the functions without the param (`lib/pricing.test.ts` pre-existing tests: append `, 100` — EXCEPT the two identity assertions from Task 1 that intentionally compare 3-arg vs 4-arg calls; give those explicit `100`s on both sides now).

- [ ] **Step 4: Typecheck sweep**

Run: `npx tsc --noEmit`
Expected: zero errors. If any call site was missed, the compiler lists it — fix by passing the site's real condition (or literal 100 with a comment only where NM-reference is the intent).

- [ ] **Step 5: Full checks**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/pricing.ts lib/pricing.test.ts app/api/inventory/import/route.ts
git commit -m "Pricing: conditionPct is now a required param; consolidate CONDITIONS"
```

---

### Task 11: Full verification + PR

- [ ] **Step 1: Full unit/integration suite** — `npm test` → all pass.
- [ ] **Step 2: Lint** — `npm run lint` → clean.
- [ ] **Step 3: e2e** — `npm run test:e2e`. Fresh worktree: treat the FIRST run as a cache-warmer (cold Turbopack) — rerun warm before diagnosing any failure. Expected: checkout smoke green (defaults are no-op, so display behavior at current settings is unchanged).
- [ ] **Step 4: Migration sanity** — confirm `lib/db/migrations/0021_*.sql` contains exactly the five ADD COLUMN statements and the journal entry; `npm test` already proves it applies (test DBs run the journal).
- [ ] **Step 5: Push branch + open PR against main** (usual repo style: summary, test plan, user-side steps). Do NOT merge. User-side step to call out: apply migration 0021 to the live dev DB (deploys don't auto-migrate; unset shell `TURSO_*` overrides before `drizzle-kit migrate` per the known gotcha).
