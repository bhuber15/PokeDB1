# Integer Pence + VAT Groundwork (Package B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every money column from float pounds to integer pence, with two boundary helpers (`formatGBP`, `parsePounds`) as the only conversion points, plus a `vatScheme` settings field so VAT registration later is a config flip.

**Architecture:** Three tasks, each a complete vertical slice: (1) schema + migration + `lib/pricing.ts` pence rework — the money-math core; (2) `lib/domain/{sales,refunds,buys}.ts` converted to pence with their tests rewritten; (3) every remaining consumer (API routes, UI components, CSV) converted at the boundary. Task 3 is mechanical — one conversion rule applied file-by-file — so its brief gives the rule and a file checklist rather than full diffs for 20+ files.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle ORM, node:test + tsx, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-07-02-risk-fixes-design.md` (Package B section — read it, it has the exact column list and the refund residual-cap formula already amended).

## Global Constraints

- Node 24 LTS; Next.js 16 App Router; TypeScript strict; **no new npm dependencies**.
- Every money column keeps its existing name; only the SQLite type and unit change (`real` pounds → `integer` pence). Ratio columns (`margin_multiplier`, `usd_to_gbp`, `eur_to_gbp`, `buy_cash_pct`, `buy_credit_pct`) stay `real`.
- `formatGBP(pence)` is the ONLY pence→pounds display conversion. `parsePounds(input: string | number): number` is the ONLY pounds→pence conversion (form inputs, CSV import). Nowhere else in the codebase does `× 100` or `/ 100` on money.
- `round2` disappears from every money path — pence arithmetic is integer, no rounding helper needed except where explicitly noted (refund residual cap, FX conversion).
- Rounding directions preserved from the pounds-era functions: sell price rounds UP (ceil) — shop never undercharges; buy price rounds DOWN (floor) — shop never overpays; FX conversion rounds to nearest.
- Migration is a plain `UPDATE t SET col = CAST(ROUND(col * 100) AS INTEGER)` per column — DB is pre-launch test data, no backup ceremony needed (per spec decision).
- Conditions: `NM | LP | MP | HP | DMG`. Currency GBP. Ponytail mode: convert what's there, don't add anything new beyond the vatScheme field the spec asks for.
- Tests run via `npm test` (`TURSO_DATABASE_URL=:memory: node --import tsx --test "**/*.test.ts"`). The harness (`lib/db/test-helpers.ts`) applies real migrations from `lib/db/migrations/` in journal order — a new migration file is picked up automatically.
- Baseline before this package: 33 tests passing, `tsc --noEmit` clean, `next build` clean, HEAD at `44a2339`.

---

## Task 1: Pence core — schema, migration, `lib/pricing.ts`

**Files:**
- Modify: `lib/db/schema.ts` (money columns → integer)
- Create: `lib/db/migrations/0007_*.sql` (generated + hand-verified)
- Modify: `lib/pricing.ts` (full pence rework)
- Modify: `lib/pricing.test.ts` (rewrite all cases in pence)
- Modify: `lib/settings.ts` (`highValueThreshold` type becomes `number` pence; add `vatScheme` field)
- Modify: `lib/db/schema.ts` again for the `vatScheme` column (same file, do both schema changes together, one migration)

**Interfaces:**
- Produces: `formatGBP(pence: number | null | undefined): string` (renders `£X.XX`, unchanged external behavior, now takes pence); `parsePounds(input: string | number): number` (returns integer pence, rounds to nearest); `calculateSellPrice(marketPence, overridePence, multiplier): number | null` (ceil); `calculateBuyPrice(marketPence, pct): number | null` (floor); `usdToGbp(usdPence???)` — **note:** USD/EUR source prices arrive as pounds-equivalent floats from external APIs (Pokemon TCG API, TCGdex), not pence — `usdToGbp`/`eurToGbp` take a **pounds float** (the API's raw number) and a rate, return **pence** (round to nearest). `pickMarketPrice` unchanged (passthrough, no unit conversion). `AppSettings.highValueThreshold: number` (pence). `AppSettings.vatScheme: 'none' | 'standard'`.

- [ ] **Step 1: Convert schema money columns to integer**

In `lib/db/schema.ts`, change every column listed in the spec's Package B section from `real(...)` to `integer(...)`, keeping the exact same field/column names:
- `inventoryItems.costPrice`, `inventoryItems.sellPriceOverride`
- `priceCache.{tcgplayerMarket,tcgplayerLow,tcgplayerMid,tcgplayerHigh,cardmarketTrend,cardmarketLow,cardmarketAvg}`
- `sales.{subtotal,discountAmount,vatAmount,total}`
- `saleItems.{priceAtSale,costAtSale}`
- `refunds.amount`
- `creditLedger.delta`
- `buyTransactions.total`
- `buyItems.payPrice`
- `settings.highValueThreshold`

Do NOT touch: `usdToGbp`, `eurToGbp`, `marginMultiplier`, `buyCashPct`, `buyCreditPct` (stay `real`).

Also add the VAT column to the same `settings` table:
```ts
vatScheme: text('vat_scheme').notNull().default('none'), // 'none' | 'standard'
```

- [ ] **Step 2: Generate and hand-verify the migration**

Run: `npx drizzle-kit generate --name pence-migration`

Drizzle's default `ALTER TABLE ... ALTER COLUMN` generation for SQLite type changes may not carry data forward correctly (SQLite has no native `ALTER COLUMN TYPE`; drizzle-kit typically emits a table-rebuild). **Open the generated `.sql` file and check**: if it does a bare type-only rebuild (copies data as-is without the ×100 conversion), you must hand-edit the migration to add explicit `UPDATE` statements for the ×100 conversion. The safe pattern, regardless of what drizzle-kit generates, is to ensure the migration performs, in order: (1) whatever schema/table changes drizzle-kit generates, (2) for every column in the list above, `UPDATE <table> SET <column> = CAST(ROUND(<column> * 100) AS INTEGER) WHERE <column> IS NOT NULL;`. If drizzle-kit's rebuild already recreates the table with old real data copied in as-is, add the UPDATE statements as a new statement block (separated by `--> statement-breakpoint`) after the table rebuild, still inside the same migration file. Also add `UPDATE settings SET vat_scheme = 'none' WHERE vat_scheme IS NULL;` defensively (the column has a SQL default so this is likely a no-op, but confirms).

This is the one step in the plan requiring judgment — if the generated SQL's shape surprises you, stop and describe what drizzle-kit produced before hand-editing, so the reviewer can check your reasoning against it.

- [ ] **Step 3: Rework `lib/pricing.ts` to pence**

```ts
export function calculateSellPrice(
  marketPence: number | null | undefined,
  overridePence: number | null | undefined,
  multiplier = parseFloat(process.env.NEXT_PUBLIC_MARGIN_MULTIPLIER ?? '0.85') || 0.85
): number | null {
  if (overridePence != null) return overridePence
  if (marketPence == null) return null
  return Math.ceil(marketPence * multiplier)
}

export function formatGBP(pence: number | null | undefined): string {
  if (pence == null) return '—'
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100)
}

// Buy-in offer = market pence × percentage, floored so we never overpay by a rounding penny.
export function calculateBuyPrice(marketPence: number | null | undefined, pct: number): number | null {
  if (marketPence == null) return null
  return Math.floor(marketPence * pct)
}

// Parses a pounds-denominated form/CSV input string or number into integer pence.
// The only pounds→pence conversion point in the codebase.
export function parsePounds(input: string | number): number {
  const pounds = typeof input === 'number' ? input : parseFloat(input)
  if (!Number.isFinite(pounds)) return 0
  return Math.round(pounds * 100)
}

// Pokemon TCG API / TCGdex return prices as plain decimal numbers in their
// native currency (USD/EUR), not pence. Convert to GBP pence at a configurable rate.
export function usdToGbp(
  usd: number | null | undefined,
  rate = parseFloat(process.env.PRICE_USD_TO_GBP ?? process.env.NEXT_PUBLIC_USD_TO_GBP ?? '0.79') || 0.79
): number | null {
  if (usd == null) return null
  return Math.round(usd * rate * 100)
}

export function eurToGbp(
  eur: number | null | undefined,
  rate = parseFloat(process.env.PRICE_EUR_TO_GBP ?? process.env.NEXT_PUBLIC_EUR_TO_GBP ?? '0.86') || 0.86
): number | null {
  if (eur == null) return null
  return Math.round(eur * rate * 100)
}

// Pick the "market" price that drives sell-price math, per shop setting.
// Both inputs are already GBP pence. Falls back to the other source if the chosen one is missing.
export function pickMarketPrice(
  prices: { tcgplayerMarket?: number | null; cardmarketTrend?: number | null } | null | undefined,
  source: 'cardmarket' | 'tcgplayer'
): number | null {
  if (!prices) return null
  const cm = prices.cardmarketTrend ?? null
  const tcg = prices.tcgplayerMarket ?? null
  return source === 'cardmarket' ? (cm ?? tcg) : (tcg ?? cm)
}
```

- [ ] **Step 4: Rewrite `lib/pricing.test.ts` in pence**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateSellPrice, calculateBuyPrice, usdToGbp, eurToGbp, formatGBP, parsePounds } from './pricing'

test('calculateSellPrice: override wins over market price', () => {
  assert.equal(calculateSellPrice(10000, 4200, 0.85), 4200)
})

test('calculateSellPrice: applies multiplier and rounds up to the penny', () => {
  assert.equal(calculateSellPrice(1000, null, 0.85), 850)
  assert.equal(calculateSellPrice(1000.1, null, 0.85), 851) // ceil, never round down
})

test('calculateSellPrice: null market with no override is null', () => {
  assert.equal(calculateSellPrice(null, null, 0.85), null)
})

test('calculateBuyPrice: floors to the penny (shop never overpays)', () => {
  assert.equal(calculateBuyPrice(1000, 0.5), 500)
  assert.equal(calculateBuyPrice(999.9, 0.5), 499)
})

test('calculateBuyPrice: null market is null', () => {
  assert.equal(calculateBuyPrice(null, 0.5), null)
})

test('usdToGbp: converts USD pounds-equivalent to GBP pence, rounds to nearest', () => {
  assert.equal(usdToGbp(10, 0.79), 790)
})

test('usdToGbp: null is null', () => {
  assert.equal(usdToGbp(null, 0.79), null)
})

test('eurToGbp: converts EUR pounds-equivalent to GBP pence', () => {
  assert.equal(eurToGbp(10, 0.86), 860)
})

test('formatGBP: formats pence as GBP currency', () => {
  assert.equal(formatGBP(790), '£7.90')
})

test('formatGBP: null/undefined renders an em dash placeholder', () => {
  assert.equal(formatGBP(null), '—')
  assert.equal(formatGBP(undefined), '—')
})

test('parsePounds: converts a pounds string to integer pence', () => {
  assert.equal(parsePounds('7.90'), 790)
  assert.equal(parsePounds('7.9'), 790)
  assert.equal(parsePounds('7'), 700)
})

test('parsePounds: converts a pounds number to integer pence', () => {
  assert.equal(parsePounds(7.9), 790)
})

test('parsePounds: non-numeric input is 0', () => {
  assert.equal(parsePounds(''), 0)
  assert.equal(parsePounds('abc'), 0)
})
```

- [ ] **Step 5: Update `lib/settings.ts`**

Change `AppSettings.highValueThreshold` stays `number` (now pence — no interface change, just documented meaning), add `vatScheme: 'none' | 'standard'` to the interface, `DEFAULT_SETTINGS` (default `'none'` — not VAT-registered, per spec decision), and `toAppSettings`:

```ts
export interface AppSettings {
  shopName: string
  usdToGbp: number
  eurToGbp: number
  marginMultiplier: number
  highValueThreshold: number // pence
  buyCashPct: number
  buyCreditPct: number
  primaryPriceSource: 'cardmarket' | 'tcgplayer'
  vatScheme: 'none' | 'standard'
}
```
Add `vatScheme: 'none'` to `DEFAULT_SETTINGS`, and `vatScheme: row.vatScheme as 'none' | 'standard'` to `toAppSettings`. `highValueThreshold`'s default in `DEFAULT_SETTINGS` (currently `parseFloat(process.env.HIGH_VALUE_THRESHOLD ?? '50') || 50`) must become pence: wrap it with `Math.round(... * 100)` since the env var is still pounds-denominated (it's a human-facing config value) — i.e. `Math.round((parseFloat(process.env.HIGH_VALUE_THRESHOLD ?? '50') || 50) * 100)`.

- [ ] **Step 6: Run full verification**

Run: `npx tsc --noEmit` — expect errors in every file that reads these columns as pounds (that's Tasks 2/3's job; for THIS task, only `lib/pricing.ts`, `lib/pricing.test.ts`, `lib/settings.ts`, `lib/db/schema.ts` need to be clean — other files' errors are expected and out of scope here. Confirm the errors you see are all in files outside this task's scope, not in the four files you touched).

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test lib/pricing.test.ts` — expect all passing.

Note: the full suite (`npm test`) will NOT pass after this task — `lib/domain/*.test.ts` still assert pounds values against pence columns. That's expected; Task 2 fixes it. Do not attempt to fix other files' tests in this task.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/ lib/pricing.ts lib/pricing.test.ts lib/settings.ts
git commit -m "feat: integer pence for money columns, vatScheme setting"
```

---

## Task 2: Domain layer conversion (`lib/domain/{sales,refunds,buys}.ts`)

**Depends on Task 1** (needs `lib/pricing.ts` pence functions, `lib/db/schema.ts` pence columns, `settings.vatScheme`).

**Files:**
- Modify: `lib/domain/sales.ts`, `lib/domain/sales.test.ts`
- Modify: `lib/domain/refunds.ts`, `lib/domain/refunds.test.ts`
- Modify: `lib/domain/buys.ts`, `lib/domain/buys.test.ts`

**Interfaces:**
- `createSale`: `CreateSaleInput.discount` and `.expectedTotal` become pence (rename to `discountP`/`expectedTotalP` per the spec's Package A→B interface note); returns `{ saleId, total }` where `total` is now pence (spec calls this `totalP` conceptually, but keep the field name `total` — only the plan's prose used the P-suffix to mark units during design, the actual field names stay as Task A defined them: `total`, not `totalP`. **Do not rename the JSON field** — only its unit changes, silently, from pounds to pence; that's an intentional breaking change the API-route/UI task (Task 3) must account for).
- `createSale` also now reads `settings.vatScheme`: when `'standard'`, `vatAmount = Math.round(afterDiscount * 0.2)`; when `'none'`, `vatAmount = 0`. This shop stays `'none'` (not registered) — the code path exists but the setting defaults off.
- `createRefund`: the residual-cap formula from the final Package A fix moves to pence — same logic (`Math.max(0, Math.min(uncapped, sale.total - refundedSoFar))`), but with pence integers there is no `round2` needed anywhere in this function; remove all `round2` calls and the `round2` helper definition itself.
- `createBuy`: merge-on-intake cost blending becomes integer pence: `newCost = Math.round((existing.costPrice * existing.quantity + payPrice * qty) / newQty)` (division can produce a fraction even with integer inputs — round to nearest pence, replacing the old `round2` two-step).

- [ ] **Step 1: Update `lib/domain/sales.ts`**

Remove the `round2` helper and every call to it (pence arithmetic doesn't need it). Replace all pound-shaped literals in comments/logic with pence equivalents. Read `settings.vatScheme` from `getSettings(dbc)` (already fetched) and compute `vatAmount` as described above instead of hardcoding `0`. The stock-decrement and credit-check logic is unit-agnostic (compares integers) — no change needed there beyond the value units already being pence via the imported pricing functions.

- [ ] **Step 2: Rewrite `lib/domain/sales.test.ts` fixture values in pence**

Every pound literal in the existing 9 tests becomes ×100. E.g. `cardmarketTrend: 10` → `cardmarketTrend: 1000` (£10.00 in pence); `costPrice: 3` → `costPrice: 300`; `expectedTotal: 17` → `expectedTotal: 1700`; assertions like `assert.equal(total, 17)` → `assert.equal(total, 1700)`; `assert.equal(items[0].priceAtSale, 8.5)` → `assert.equal(items[0].priceAtSale, 850)`. Add ONE new test asserting the VAT path: set `settings.vatScheme = 'standard'` via `dbc.update(schema.settings).set({ vatScheme: 'standard' }).where(eq(schema.settings.id, 1))` before a sale, assert `vatAmount` is 20% of the post-discount subtotal and `total` includes it.

- [ ] **Step 3: Update `lib/domain/refunds.ts`**

Remove `round2` and its calls. The residual-cap fix from Package A (`44a2339`) is already integer-safe in shape (`Math.max`/`Math.min`) — verify it still reads correctly with pence inputs and drop any remaining `round2()` wrapping around the cap computation. The `chargedRatio = sale.total / sale.subtotal` division and `netAmount * chargedRatio` multiplication now operate on pence integers but the *result* must still be rounded to an integer pence value (`Math.round`, not `round2`) before comparing/inserting — division doesn't stay integer.

- [ ] **Step 4: Rewrite `lib/domain/refunds.test.ts` fixture values in pence**

Same ×100 treatment as sales.test.ts. The three-successive-refunds cap test (from the Package A final fix) is the one to check most carefully: with pence fixtures (subtotal 2550, total 2000, unit price 850), the same 667/667/666 pence sequence should hold (equivalent to the old £6.67/£6.67/£6.66).

- [ ] **Step 5: Update `lib/domain/buys.ts`**

Remove `round2` and its calls; replace the merge-cost-blend formula with the integer version shown above (`Math.round` instead of `round2`'s `Math.round(n*100)/100` two-step, since there's no `/100` step in pence).

- [ ] **Step 6: Rewrite `lib/domain/buys.test.ts` fixture values in pence**

Same ×100 treatment. Check the merge-on-intake test's blended cost assertion still computes correctly in pence.

- [ ] **Step 7: Run full verification**

Run: `TURSO_DATABASE_URL=:memory: node --import tsx --test "lib/domain/*.test.ts"` — expect all passing (23 tests: 9 sales + 1 new VAT + 6 refunds + 4 buys, adjust count to what actually exists in each file — verify by counting `test(` occurrences before and after).

Run: `npx tsc --noEmit` — `lib/domain/*.ts` and their tests must be clean now; errors remaining should only be in Task 3's scope (routes, components, CSV). Confirm this split explicitly in your report.

- [ ] **Step 8: Commit**

```bash
git add lib/domain/sales.ts lib/domain/sales.test.ts lib/domain/refunds.ts lib/domain/refunds.test.ts lib/domain/buys.ts lib/domain/buys.test.ts
git commit -m "feat: convert domain layer to integer pence, VAT scheme applied in createSale"
```

---

## Task 3: Boundary sweep — routes, components, CSV, settings UI

**Depends on Task 2** (all domain functions now speak pence).

**The rule:** every file below either (a) sends/receives raw pence values to/from an API or DB and needs NO change (pure passthrough — most API routes), or (b) displays money to a human or reads money from a human/CSV, and needs exactly one boundary conversion added: `formatGBP(pence)` when displaying, `parsePounds(input)` when accepting pounds-denominated text input. **The rule is never to do arithmetic across the boundary** — a component either holds a pence integer end-to-end, or converts once at the edge.

**Files (convert per the rule; each gets a one-line note on what changes):**

- `app/api/settings/route.ts` — passthrough, but the PATCH body may include `highValueThreshold` as pounds from the settings form; if so, convert with `parsePounds` server-side OR require the client to send pence already (prefer: client sends pence, matching the money-columns-are-pence-everywhere-except-UI-edges rule — see SettingsForm below). No conversion in the route itself if the client is fixed correctly.
- `app/api/inventory/route.ts`, `app/api/inventory/[id]/route.ts` — POST/PATCH bodies accept `costPrice`/`sellPriceOverride` from `AddItemForm`/`InventoryTable` edit forms. Same rule: fix the client to send pence (via `parsePounds` at form submission), route stays a passthrough. Grep the route bodies for any inline `* 100` or `/ 100` — remove any found (there shouldn't be any today, but check).
- `app/api/sales/[id]/items/route.ts`, `app/api/reports/sales/route.ts`, `app/api/reports/sales/export/route.ts`, `app/api/cards/search/route.ts`, `app/api/buys/route.ts` — passthrough; verify no arithmetic on money fields exists in these routes (they aggregate/query, they don't compute — confirm with a read, don't assume).
- `app/api/inventory/export/route.ts`, `app/api/inventory/import/route.ts` — **these are the one deliberate exception to "CSV stays pounds"**: CSV files are human-facing (opened in Excel), so export must convert pence→pounds with `formatGBP`-equivalent-but-numeric (formatGBP returns a `£`-prefixed string; CSV needs a bare number — use `(pence / 100).toFixed(2)`, NOT formatGBP, since formatGBP's currency symbol would corrupt the CSV numeric column) when writing cost/price columns, and import must convert pounds→pence with `parsePounds` when reading them back in. Read both files fully before editing — they likely loop over rows with named columns; find every money column reference (`costPrice`, `sellPriceOverride`) and wrap it at the read/write boundary only.
- `app/(app)/pos/page.tsx`, `components/pos/CardResult.tsx`, `components/pos/Cart.tsx`, `components/pos/CheckoutDialog.tsx`, `components/pos/SearchBar.tsx` (if it touches money) — the POS already computes prices via `calculateSellPrice`/`pickMarketPrice` (pure functions, now pence-native from Task 1) and passes `expectedTotal`/cart item prices straight through to `createSale` — this should need ZERO new conversions, only `formatGBP` calls already present continue to work correctly since they now receive pence (which is what Task 1 changed `formatGBP` to expect). Verify by reading: every money value flowing through these files should already be pence by construction once Tasks 1-2 land; the only risk is a place that does its own pounds arithmetic instead of calling `calculateSellPrice`/`formatGBP` — grep for stray `* 0.85`, `/ 100`, `* 100` and fix any found.
- `components/buylist/BuyCard.tsx`, `components/buylist/BuyCart.tsx` — same pattern as POS: verify pence flows through by construction (via `calculateBuyPrice`), fix any stray arithmetic.
- `components/inventory/AddItemForm.tsx` — **needs a real fix**: this form has a text/number input for `costPrice` (and possibly `sellPriceOverride`) that the shop staff types in pounds. On submit, wrap the raw input value with `parsePounds()` before sending to the API. Read the file to find exactly where the input value is read (likely `parseFloat(formData.get(...))` or a controlled `useState<string>`) and replace that pounds-parsing with `parsePounds` from `lib/pricing.ts`.
- `components/inventory/InventoryTable.tsx` — displays `costPrice`/`sellPriceOverride`/computed sell price: wrap every display with `formatGBP` (likely already does — verify, since `formatGBP` signature is unchanged, only its input unit changed, so if it was already calling `formatGBP(costPrice)` it now correctly shows pence-as-pounds with zero code change; the risk is any place doing its OWN pounds formatting like `£${costPrice.toFixed(2)}` instead of calling `formatGBP` — find and replace those with `formatGBP`). If the table has an inline edit input for cost/override, same `parsePounds`-on-submit fix as AddItemForm.
- `components/reports/RefundDialog.tsx` — displays refund amounts; same `formatGBP` verification as InventoryTable, plus if it has an editable amount field (unlikely per Package A's design — refunds are quantity-driven, not amount-driven), check for that too.
- `components/customers/CustomerDetail.tsx`, `components/shared/CustomerPicker.tsx` — displays credit balance (from `creditLedger.delta` SUM, now pence); `getCustomerBalance` in `lib/credit.ts` sums the column directly (no arithmetic beyond SUM, still correct in pence) — verify its callers format the returned pence value with `formatGBP` rather than doing their own pounds math.
- `components/shared/CardZoomModal.tsx` — displays sell/market prices; `formatGBP` verification only.
- `components/settings/SettingsForm.tsx` — **needs a real fix**: `highValueThreshold` is now pence in the DB/API but this is a form staff type a pounds value into (e.g. "£50"). On load, convert the fetched pence value to a pounds display string for the input (`(highValueThreshold / 100).toFixed(2)` — a display-only conversion, not `formatGBP` since it's an editable input, not static text); on submit, convert back with `parsePounds` before sending to the API. Also add the `vatScheme` field to this form: a simple toggle/select between `'none'`/`'standard'`, defaulting to whatever the fetched settings say (which will be `'none'` — this shop isn't registered, but the toggle should exist and work so registering later is a UI click, not a deploy).
- `components/shared/SettingsProvider.tsx` — check its `AppSettings`-shaped context type still matches `lib/settings.ts`'s updated interface (it likely just re-exports the type or passes it through — if so, no change needed beyond TypeScript picking up the new `vatScheme` field automatically).
- `app/(app)/prices/page.tsx`, `app/(app)/inventory/page.tsx`, `app/(app)/reports/page.tsx` — page-level components; verify any inline money display uses `formatGBP`, fix stray formatting if found.

**Do NOT touch:** `lib/apis/pokemon-tcg.ts`, `lib/apis/tcgdex.ts` (these return raw USD/EUR pounds-equivalent numbers from external APIs — Task 1's `usdToGbp`/`eurToGbp` already handle the pounds→pence conversion at the point those values enter `price_cache`; verify `lib/prices/sync.ts` calls them correctly but don't change the API client files themselves), `app/api/cron/sync-prices/route.ts` (passthrough, calls `lib/prices/sync.ts` which Task 1's pricing functions already made pence-correct).

- [ ] **Step 1: Grep for every remaining money-arithmetic call site outside `lib/pricing.ts`**

Run: `grep -rn '\* 100\|/ 100\|round2\|\.toFixed(2)' app components lib --include="*.tsx" --include="*.ts" | grep -v ".test.ts" | grep -v "lib/pricing.ts"`

This surfaces every place doing its own unit conversion or pounds-rounding outside the two sanctioned boundary functions. Each hit is either: legitimate (the CSV `.toFixed(2)` conversions from the rule above, or the SettingsForm pence-to-pounds-for-editing conversion) or a bug to fix (replace with `formatGBP`/`parsePounds`). Triage every hit before touching code.

- [ ] **Step 2: Apply the conversions per the file list above**

Work through each file. For files marked "verify only," confirm and move on — don't add unneeded code. For files marked "needs a real fix" (`AddItemForm.tsx`, `InventoryTable.tsx`'s inline edit if present, `SettingsForm.tsx`, `inventory/export` + `inventory/import` routes), make the fix.

- [ ] **Step 3: `npx tsc --noEmit`**

Expected: zero errors across the whole project. This is the real completion signal for the pence migration — TypeScript will have flagged every mismatched pounds/pence assumption along the way if the domain layer's types are pence-typed correctly (they're all still just `number`, so TS won't catch unit mistakes by itself — this is why the grep in Step 1 matters more than tsc here, but tsc clean is still required as a baseline sanity check).

- [ ] **Step 4: `npm test`**

Expected: all tests passing (same count as end of Task 2 — this task touches no `.test.ts` files, only production code and the CSV/UI consumers).

- [ ] **Step 5: `npx next build`**

Expected: clean build, same route count as Package A's baseline (38 routes).

- [ ] **Step 6: Migrate the dev Turso database**

Run: `npx drizzle-kit migrate` (uses `.env.local` credentials). If this fails, report DONE_WITH_CONCERNS noting the failure — the schema/migration file is still the deliverable; a controller can apply it separately (see Package A Task 3 precedent).

- [ ] **Step 7: Commit**

```bash
git add app components lib
git commit -m "feat: convert API/UI money boundaries to pence with formatGBP/parsePounds"
```

---

## Post-plan verification (controller, not a task)

- `npm test`, `npx tsc --noEmit`, `npx next build` all green.
- Manual browser pass (still deferred per Package A's ledger — do this after Package D, covering both packages at once): a sale showing correct pounds display end-to-end, a buy, a refund, CSV export opened and showing correct pounds values, CSV re-import round-tripping correctly, Settings form showing/saving the high-value threshold and VAT scheme correctly.
- Update `.superpowers/sdd/progress-package-a.md` (or start a `progress-package-b.md`) as tasks complete, following the Package A ledger conventions.
- Then proceed to Package C (price history + resilient sync).
