# VAT Margin Scheme (second-hand goods) — design spec

**Feature:** F2 from `docs/superpowers/plans/2026-07-07-feature-gap-review.md`
**Date:** 2026-07-11
**Effort:** L (tax-compliance sensitive; one migration)
**Status:** Approved design — ready for implementation plan.

---

## 1. Background

A UK shop reselling used cards uses the **VAT Margin Scheme**: VAT is due on the
**margin** (sale price − purchase/cost price) of each item, not the full sale price.
Margin VAT is **VAT-inclusive** — it is *already inside* the shelf price the customer
pays, not added on top. For the standard 20% rate, per line:

```
marginVat = round( max(0, salePrice − costAtSale) × 1/6 )
```

Groundwork already in place:

- `sale_items.cost_at_sale` — per-line cost snapshot captured at sale time
  (`lib/domain/sales.ts`). This is the cost basis the scheme requires.
- `settings.vat_scheme` — text column, already anticipates `'margin'` in its schema
  comment; `lib/settings.ts` currently types it `'none' | 'standard'`.
- `computeSaleTotals` (`lib/pricing.ts:64`) — implements only `none` (0) and
  `standard` (20% on the discounted subtotal). It takes `(subtotal, discount, vatScheme)`
  and has **no per-line cost data**.

## 2. The key insight that shapes the whole design

**Margin VAT is VAT-inclusive, so the customer-facing total under `margin` is identical
to `none`.** Two consequences drive every decision below:

1. **The client never needs cost data.** `computeSaleTotals` stays the customer-total
   function (client + server); the client keeps computing `expectedTotal` with no cost
   in the browser. The margin VAT figure is computed **server-side only** from
   `cost_at_sale`, stored on the sale, and used for reporting. This preserves the
   critical client-bundle boundary (cost / `lib/domain` / `lib/db` never reach the
   browser — see `pokedb-client-bundle-boundary`).
2. **The Margin Scheme legally forbids showing a separate VAT amount on the customer
   receipt.** So under `margin` the receipt shows **no VAT line** — the opposite of
   Standard VAT.

## 3. Product-direction context

PokeDB is **likely to be sold/licensed to other UK card shops**, so this feature is
designed **defensively** (see `pokedb-product-direction`): never silently mis-state a
shop's tax, prefer per-shop settings over hardcoded single-shop assumptions, centralise
the VAT rate, and treat the legally-required stock book as in-scope. It stays
single-tenant per install (settings remain the single `id = 1` row) — no multi-tenant
infrastructure.

## 4. Decisions (all signed off 2026-07-11)

| # | Decision | Choice |
|---|----------|--------|
| D1 | No-cost lines (`cost_at_sale` null — can't legally be in the scheme) | **Per-shop setting**, default **exclude + prominent warning** (see D5) |
| D2 | Whole-sale discount vs taxable margin | **Spread across lines proportionally**, reducing each line's effective sale price before computing margin |
| D3 | Rounding granularity of `× 1/6` | **Per line** (per `sale_items` row) |
| D4 | Stock book (legally required) | **Full stock-book CSV export**, in scope now |
| D5 | Receipt wording under margin | Discreet **"Sold under the VAT Margin Scheme"** note, **no VAT figure** |
| D6 | Refunds on margin sales | **Explicit out-of-scope follow-up** (see §10) |

## 5. Core arithmetic (`lib/pricing.ts` — pure, dependency-free, unit-tested)

### 5.1 `computeSaleTotals` — customer totals (client + server)

Signature **unchanged**: `(subtotalPence, discountPence, vatScheme)`. Widen `vatScheme`
to `'none' | 'standard' | 'margin'`. Returns `{ discount, vatAmount, total }`:

| Scheme | `vatAmount` returned | `total` |
|--------|----------------------|---------|
| `none` | `0` | `afterDiscount` |
| `standard` | `round(afterDiscount × 0.2)` | `afterDiscount + vatAmount` |
| `margin` | `0` | `afterDiscount` |

Here `vatAmount` means **VAT added on top of the customer total**. For `margin` it is `0`
because margin VAT is inclusive — it does not change what the customer pays. `discount`
is clamped to `[0, subtotal]` exactly as today. **Existing `none`/`standard` behaviour and
tests are unchanged.**

The VAT **rate** moves into a single named constant (e.g. `VAT_RATE = 0.2`, with the
inclusive divisor `VAT_FRACTION_DIVISOR = 6` i.e. `1/6`) so a future rate change is a
one-line edit rather than scattered magic numbers.

### 5.2 `computeMarginVat` — margin VAT owed (server-only, pure)

New pure function in `lib/pricing.ts` (no DB import, so it stays client-safe by
construction and is unit-tested directly):

```
computeMarginVat(
  lines: { unitPrice: number; quantity: number; costAtSale: number | null }[],
  discountPence: number,
): { vatAmount: number; noCostLineCount: number }
```

Algorithm (all integer pence):

1. `subtotal = Σ unitPrice × quantity`; clamp `discount` to `[0, subtotal]`.
2. **Allocate the discount across lines proportionally to line value**
   (`lineValue = unitPrice × quantity`) using the **largest-remainder method**, so the
   per-line allocations are integers that sum **exactly** to `discount` (no rounding
   drift, no line over-allocated beyond its value).
3. For each line:
   - `effLineValue = lineValue − allocatedDiscount`
   - if `costAtSale == null` → `noCostLineCount++`, contributes **£0** VAT (D1).
   - else `margin = max(0, effLineValue − costAtSale × quantity)`,
     `lineVat = round(margin / 6)` (D3 — rounded per line).
4. `vatAmount = Σ lineVat` over cost-bearing lines.

Margins are floored at 0 **per line** — a loss on one card cannot offset VAT on
another (that pooling is only allowed under HMRC's Global Accounting Scheme, which is
not implemented here).

## 6. `createSale` (`lib/domain/sales.ts`)

`sales.vat_amount` is stored as **"VAT owed to HMRC for this sale"** for every scheme,
keeping reporting uniform:

1. Compute customer totals: `const { discount, vatAmount, total } =
   computeSaleTotals(subtotal, input.discount ?? 0, settings.vatScheme)`.
   `total` is verified against `expectedTotal` as today (unchanged for `margin`/`none`).
2. If `settings.vatScheme === 'margin'`:
   - `const { vatAmount: marginVat, noCostLineCount } = computeMarginVat(lines, discount)`
   - If `settings.marginNoCostHandling === 'block'` **and** `noCostLineCount > 0`:
     throw `DomainError('MARGIN_NO_COST', …)` **before** the transaction commits (no stock
     decrement, no sale row). New error code in `lib/domain/errors.ts` usage → maps to 4xx.
   - Otherwise store `vat_amount = marginVat`.
3. Else store `vat_amount = vatAmount` (standard's add-on, or 0 for none).
4. Store `sales.vat_scheme = settings.vatScheme` (already captured).
5. **Return shape gains `marginNoCostCount`**: `{ saleId, total, marginNoCostCount }`
   (0 for non-margin or no-cost-free sales) so the till can warn without ever seeing cost.

`lines` already carry `unitPrice` and `costAtSale` in `createSale`, so no new query is
needed.

## 7. Settings (`lib/settings.ts`, DB, validation, UI)

### 7.1 Types & DB

- `AppSettings.vatScheme`: `'none' | 'standard' | 'margin'`.
- New field `AppSettings.marginNoCostHandling: 'exclude' | 'block'` (default `'exclude'`).
- `lib/db/schema.ts` `settings`: **add** `marginNoCostHandling: text('margin_no_cost_handling').notNull().default('exclude')`.
  Update the `vat_scheme` comment to `'none' | 'standard' | 'margin'`.
- **One drizzle migration** (`npx drizzle-kit generate`) for the new column. `vat_scheme`
  needs no DB change — it is text and already stores arbitrary scheme strings.
- `DEFAULT_SETTINGS` gains `marginNoCostHandling: 'exclude'`; `toAppSettings` maps the
  new column (cast to the union).

### 7.2 Validation (`app/api/settings/route.ts`)

- Accept `vatScheme` ∈ `{'none','standard','margin'}` (extend the existing check).
- Accept `marginNoCostHandling` ∈ `{'exclude','block'}` when present.

### 7.3 Settings UI (`components/settings/SettingsForm.tsx`)

- VAT scheme control: 2-way toggle → **3-way** — *Not registered* / *Standard VAT* /
  *Margin scheme*.
- When *Margin scheme* is selected, reveal a **no-cost handling** control
  (*Exclude & warn* / *Block sale*) with plain-English helper text and a short worked
  example (e.g. "Sell a card for £10 that cost you £4 → VAT owed = round(£6 × 1/6) = £1.00,
  already included in the £10").
- Send `vatScheme` and `marginNoCostHandling` in the PATCH body.

## 8. POS & receipt surfaces

### 8.1 CheckoutDialog (`components/pos/CheckoutDialog.tsx`)
Calls `computeSaleTotals(subtotal, discount, vatScheme)` — under `margin` this returns
`vatAmount = 0`, so **no VAT line renders**. Optionally show the discreet margin-scheme
note. Standard/none unchanged.

### 8.2 ReceiptDialog (`components/pos/ReceiptDialog.tsx`)
- Add `vatScheme: 'none' | 'standard' | 'margin'` to `ReceiptData`.
- Under `margin`: render **no VAT row**; render a discreet line
  **"Sold under the VAT Margin Scheme"** (both in the on-screen dialog and the printed
  `receiptHtml`).
- Under `standard`: the existing `VAT (20%)` row (only when `vatAmount > 0`).
- Under `none`: unchanged.

### 8.3 POS page (`app/(app)/pos/page.tsx`)
- Populate `ReceiptData.vatScheme` from settings. `ReceiptData.vatAmount` continues to come
  from `computeSaleTotals(...).vatAmount` (0 under margin → no figure shown).
- After a successful sale, if the response's `marginNoCostCount > 0`, show a **prominent
  warning toast** (e.g. "N card(s) had no cost basis — excluded from margin VAT. Review the
  margin stock book.") — this is the non-silent surface required by the defensive posture.

## 9. Reporting & the legal stock book

### 9.1 Existing sales report (`app/api/reports/sales/route.ts`)
Already sums `sales.vat_amount` into `vatTotal` — margin VAT flows in automatically once
stored. No structural change required; margin VAT is now reflected in the VAT total.

### 9.2 Stock-book export (new)
Legally required record of purchase→sale per margin-scheme item.

- **Domain query** in `lib/domain/reports.ts`: for a date range, join
  `sale_items → sales` (where `sales.vat_scheme = 'margin'`) → `inventory_items → cards`.
  Emit one row per margin sale-line: sale date, sale #, card name, condition, quantity,
  **cost/purchase price** (`cost_at_sale`), **sale price** (`price_at_sale`), **margin**
  (`max(0, price − cost)`), **VAT** (`round(margin / 6)`), and a **no-cost flag**
  (`cost_at_sale is null`). This mirrors §5.2 so the export and the stored figures agree.
- **Route**: `GET /api/reports/margin-stock-book` — admin-only (`requireAdmin`), wrapped in
  `guarded()`, `from`/`to` validated like the sales report. CSV via existing
  `lib/csv.ts` `toCSV` (formula-injection-safe). Returns `text/csv`.
- Money columns are formatted at the CSV edge (pounds), values are exact integer-pence
  sums internally.

> Note: `cost_at_sale` is the blended cost snapshot actually used as the basis — the
> correct figure for the margin. Linking each line back to a specific `buy_item` purchase
> record is a possible future enhancement, not required for a valid stock book.

## 10. Out of scope — refunds (documented follow-up) — D6

A refund against a margin-scheme sale **reduces the margin VAT owed**, and a fully correct
stock book should **net refunded items** out of the margin totals. `refunds.amount`
"includes reversed VAT" for the standard/none world, but margin VAT is not currently
apportioned on refunds. Handling this correctly means teaching the refund engine
(`lib/domain/refunds.ts`) to recompute per-line margin VAT reversals and reflecting them in
the stock book — a meaningful chunk of work touching a separate subsystem.

**Decision:** ship the margin scheme focused on the sale path; treat refund-side margin VAT
as an explicit follow-up. Until then, the stock book reflects **gross** margin sales (not net
of refunds), which is a known, documented limitation to reconcile manually. This will be
raised as its own backlog item.

## 11. Files touched

| File | Change |
|------|--------|
| `lib/pricing.ts` | Widen `computeSaleTotals` scheme union + `margin` case; add `computeMarginVat`; centralise VAT rate constants |
| `lib/pricing.test.ts` | Margin math, proportional discount allocation, per-line rounding, no-cost lines; keep none/standard green |
| `lib/db/schema.ts` | Add `margin_no_cost_handling` column; update `vat_scheme` comment |
| `lib/db/migrations/**` | New generated migration for the settings column |
| `lib/settings.ts` | Widen `vatScheme`; add `marginNoCostHandling`; defaults + mapping |
| `app/api/settings/route.ts` | Validate `margin` scheme + `marginNoCostHandling` |
| `components/settings/SettingsForm.tsx` | 3-way VAT toggle + no-cost control + worked example |
| `lib/domain/sales.ts` | Store margin VAT via `computeMarginVat`; `block` handling; return `marginNoCostCount` |
| `lib/domain/sales.test.ts` | Margin stores correct `vat_amount`; exclude vs block; total unchanged |
| `components/pos/ReceiptDialog.tsx` | `vatScheme` on `ReceiptData`; margin note, no VAT line |
| `components/pos/CheckoutDialog.tsx` | No VAT line under margin (falls out of `computeSaleTotals`) |
| `app/(app)/pos/page.tsx` | Pass `vatScheme` to receipt; warning toast on `marginNoCostCount > 0` |
| `lib/domain/reports.ts` | Stock-book query |
| `app/api/reports/margin-stock-book/route.ts` | New admin CSV export |
| `lib/domain/reports.test.ts` (or colocated) | Stock-book query rows correct |

## 12. Domain-rule compliance checklist

- **Integer pence throughout** — all margin math is integer pence; conversion to pounds
  only at the CSV/UI edge. ✅
- **Server-canonical prices** — client sends no prices; margin VAT computed server-side. ✅
- **Client-bundle boundary** — cost / `computeMarginVat` never imported into client
  components; the till learns of no-cost lines via a returned integer count only. ✅
- **Thin routes** — margin VAT and stock-book logic live in `lib/pricing.ts` /
  `lib/domain/`; routes stay thin and `guarded()`. ✅
- **Changed behaviour has tests** — colocated tests for all changed pricing/domain logic. ✅

## 13. Verification gate

All must be green before "done":

- `npm test`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`

Plus: the migration is generated but **applied to the live DB only by the user**
(deploy does not auto-migrate; unset shell `TURSO_*` before `drizzle-kit migrate` — see
`pokedb-migration-deploy-gotcha`).
