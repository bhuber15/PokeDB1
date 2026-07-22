# Condition-based pricing — design

Source: first-shop demo 2026-07-22 ("played-condition cards should not price at full
market"), brainstormed from `2026-07-22-condition-pricing-stub.md`. Supersedes the stub.

Decisions confirmed with the owner 2026-07-22: recommended ladder NM 100 / LP 85 /
MP 70 / HP 50 / DMG 35 as an editable Settings preset; one shared ladder for sell and
buy sides; owner-editable Settings UI ships now.

## Summary

A per-shop condition ladder — integer percent per condition (NM | LP | MP | HP | DMG) —
scales the market price before the existing margin/offer math, everywhere a
market-derived price surfaces. Manual `sellPriceOverride` stays absolute and wins over
everything. DB defaults are 100 across the board, so existing shops see **zero price
change** until they edit the ladder (or click the preset) in Settings.

## Pricing math (lib/pricing.ts — dependency-free, client-safe; keep it that way)

New exports:

- `CONDITIONS = ['NM','LP','MP','HP','DMG'] as const` and `type Condition` — single
  source of truth; `components/buylist/BuyCard.tsx` and `lib/domain/buys.ts` currently
  each define their own copy and switch to importing this one.
- `type ConditionLadder = Record<Condition, number>` — integer percents, valid range
  1–100.
- `conditionPct(ladder, condition): number` — tolerant lookup. Unknown condition
  string, missing ladder, or out-of-range/non-integer value → **100** (prices at full
  market, i.e. today's behavior; never silently discounts on bad data).
- `applyConditionPct(marketPence, pct): number` = `Math.max(1, Math.round(marketPence
  * pct / 100))`. Integer in, integer out. The `max(1, …)` clamp stops a 1p market
  card rounding to a £0 price (a 0 price would slip past createSale's `== null`
  NO_PRICE guard and sell for free).

Changed signatures — the condition percent is a **required** parameter so the compiler
forces every current and future call site to make an explicit condition decision:

```ts
calculateSellPrice(marketPence, overridePence, multiplier, conditionPct: number)
// override wins → null market → null → else Math.ceil(applyConditionPct(market, conditionPct) * multiplier)

calculateBuyPrice(marketPence, pct, conditionPct: number)
// null market → null → else Math.floor(applyConditionPct(market, conditionPct) * pct)
```

Rounding order is fixed and shared: condition step first (round, integer pence), then
sell ceil / buy floor exactly as today. The conditioned market is a first-class integer
quantity — the buy cap (below) reuses it. Call sites that intentionally mean
"NM-reference / no condition context" (generic Settings examples) pass a literal `100`.

## Settings

**Schema** (`lib/db/schema.ts`, settings table — follows the existing
one-column-per-setting pattern): five integer columns `cond_sell_pct_nm`,
`cond_sell_pct_lp`, `cond_sell_pct_mp`, `cond_sell_pct_hp`, `cond_sell_pct_dmg`, all
`NOT NULL DEFAULT 100`. Migration generated with `npx drizzle-kit generate` (expected
0021). Default 100 backfills every existing row/tenant as a no-op. One shared ladder:
it feeds both sell prices and buylist offers (owner confirmed; a separate buy-side
ladder, if ever wanted, is 5 nullable columns falling back to these — no migration
pain, so YAGNI now).

**lib/settings.ts**: `AppSettings` gains `conditionSellPct: ConditionLadder`.
`DEFAULT_SETTINGS` uses all-100. `toAppSettings` assembles the record from the five
columns; `updateSettings` maps the record back to columns (destructure `conditionSellPct`
from the patch, spread the five column values). `components/shared/SettingsProvider.tsx`
has a hand-written fallback `AppSettings` object (it cannot import lib/settings — that
pulls lib/db into the client bundle); it gains the all-100 record too.

**API** (`app/api/settings/route.ts` PATCH): accepts optional `conditionSellPct` with
all five keys, each an integer 1–100 (reject partial records — the UI always sends the
full ladder). This is a changed endpoint, so per AGENTS.md its hand-rolled body
validation migrates to `parseBody` + a zod schema preserving current semantics
(per-field constraints identical, ≥1 valid field required, errors as 400 + `{ error }`
— verify the guarded/parseBody error shape keeps SettingsForm's error toasts working).

**UI** (`components/settings/SettingsForm.tsx`, follows the existing card + live-example
pattern): a "Condition pricing" card with five percent inputs (NM, LP, MP, HP, DMG), a
live example row showing what a £10.00-market card sells for per condition at the
current margin, a **"Use recommended ladder"** button filling 100/85/70/50/35, and a
reset-to-100 note ("100 across the board = condition pricing off"). Copy states the
ladder applies to both sell prices and buylist offers.

## Application points

Sell side — every call site passes its line's condition through
`conditionPct(settings.conditionSellPct, condition)`:

1. `lib/domain/sales.ts` createSale (server-canonical; `row.item.condition`).
2. `components/pos/CardResult.tsx` POS price check/display (`selected.condition`) —
   client and server share inputs + function, so `expectedTotal` keeps matching.
3. `components/inventory/InventoryTable.tsx` (`group.condition`).
4. `app/(app)/inventory/page.tsx` single QR-label modal (`row.item.condition`).
5. `app/api/labels/batch/route.ts` batch QR labels (`item.condition`).
6. `app/api/inventory/export/route.ts` — **new `sell_price` CSV column** (pounds,
   2 dp, blank when no price), computed identically to the POS. Today the export has
   no computed sell price at all; this is the "CSV export" surface. Implementation
   must check the CSV import path tolerates the extra column (round-trip safety).
7. `components/settings/SettingsForm.tsx` examples: existing generic examples pass
   literal 100; the new card renders the full ladder preview.

Buy side:

8. `components/buylist/BuyCard.tsx` — cash/credit offers become
   `calculateBuyPrice(market, buyCashPct|buyCreditPct, conditionPct(ladder, condition))`
   using the card's condition selector state, so toggling condition updates the offer
   badges, the summary line, and the `payPriceCash`/`payPriceCredit` sent to the buy
   sheet.
9. `lib/domain/buys.ts` createBuy — the non-admin 110% overpayment cap compares against
   the **conditioned** market per line (`applyConditionPct` + integer cross-multiply as
   today), closing the "pay NM money for a DMG card" gap; `maxPay` in the error uses the
   conditioned value. Admin exemption unchanged. `marketAtBuy` snapshot stays **raw**
   market (it is a market reference; the line already records its condition).

## Non-goals (explicit)

- `/prices` research page: shows raw market reference numbers (TCGplayer/Cardmarket),
  not shop sell prices — untouched.
- `getInventoryValuation` marketValue: documented as raw market by design — untouched
  (revisit if the shop wants condition-honest stock value).
- Historical snapshots (receipts, refunds caps, sales/buys CSV exports, `priceAtSale`,
  `payPrice`): already-recorded money, never recomputed.
- `price_cache` / price sync: stays raw market — the ladder applies at read time, so
  ladder edits take effect immediately without a resync.
- Per-game ladders: multi-game catalogue stub owns that restructure.
- Products (non-card SKUs): price via override only (no market price), so the ladder
  never touches them.

## Testing

- `lib/pricing.test.ts`: `conditionPct` lookup (known / unknown condition / invalid
  values → 100); `applyConditionPct` rounding and the ≥1p clamp; `calculateSellPrice`
  with ladder — override still wins, pct 100 reproduces today's values penny-exact,
  LP-85 example pinned; `calculateBuyPrice` same; rounding-order pinned with exact
  integer expectations.
- `lib/domain/sales.test.ts`: with a non-default ladder, createSale prices an LP item
  at conditioned market × margin; with default settings the totals are pre-feature
  byte-identical; `expectedTotal` drift still throws PRICE_CHANGED.
- `lib/domain/buys.test.ts`: non-admin cap enforced against conditioned market (DMG
  line rejected at old raw-market cap value); admin exempt; default ladder → cap
  behavior identical to today.
- Settings route/domain tests: zod migration keeps existing valid/invalid cases
  passing; new ladder field accepts a full 1–100 integer record, rejects partial
  records and out-of-range values.
- Playwright e2e: **no change** — defaults are no-op so current display behavior is
  identical; checkout smoke must stay green. (Fresh-worktree rule: first run is a
  cache-warmer, rerun warm before diagnosing.)

## Migration / deploy notes

- One migration (expected `0021_*`) adding the five settings columns. Deploys do NOT
  auto-migrate: applying it to the live dev DB is a user-side step (list in the PR /
  final summary). No data backfill needed beyond the column defaults. No platform
  registry migration.
