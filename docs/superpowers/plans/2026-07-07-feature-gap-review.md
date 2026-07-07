# PokeDB — Full-build review & feature-gap plan (2026-07-07)

Outcome of a full code review of the whole build. Part 1 records the bugs found
and fixed this session. Part 2 is the prioritised backlog of features/sub-features
that appear to be missing, ready to pick up on return.

---

## Part 1 — Review result & fixes applied this session

**Baseline health:** `tsc`, `eslint`, all tests, and `next build` were green before and
after. Test count went 109 → 119 (added CSV + id-param coverage). No broken build.

**Fixes landed (all with green tsc/lint/test/build):**

| Area | Issue | Fix |
|------|-------|-----|
| `lib/csv.ts` | **CSV formula injection** — exported free-text (`name`, `location`, `defect_notes`) starting with `= + - @` executes as a formula when the owner opens the file in Excel/Sheets. | `escapeField` now prefixes at-risk **string** values with `'`; numeric columns pass through untouched. New `lib/csv.test.ts`. |
| `app/api/cron/sync-prices` | **Fail-open cron auth** — an unset `CRON_SECRET` made the expected header literally `Bearer undefined`. | Fails closed when the secret is unset. |
| `app/api/reports/sales` | **Gross-margin drift** — margin joined *live* `inventory_items.cost_price`, so re-buying a card (which blends cost basis) retroactively changed past margins. | Uses the `sale_items.cost_at_sale` snapshot instead. |
| `app/api/buys` (GET) | Buy-transaction history (payout totals) was readable by any staff PIN, while sales history is admin-only. Endpoint has no UI caller. | Upgraded to `requireAdmin`. |
| 8 routes + `lib/validation.ts` | `parseInt(id)` with no guard let `NaN` reach the DB and masquerade as a 404. | New `parseIdParam()` helper (throws `INVALID_INPUT` → 400); wired through all `[id]` routes + inventory `cardId` query + wants `id`. Tested. |
| `components/reports/RefundDialog` | No `try/finally` — a network error left the Refund button disabled forever. | `try/catch/finally`, re-guarded against double submit. |
| `components/shared/CustomerPicker` | No in-flight guard — double-click created duplicate customers. | `submitting` state + `try/finally`; button disabled while in flight. |
| `components/inventory/InventoryTable` | `StockCell` was defined **inside** the component, so React remounted the edit `<input autoFocus>` on every keystroke (caret reset / focus churn). | Hoisted `StockCell` to module scope with props. |
| `components/buylist/BuyCard` | Buy offers shown to staff used `tcgplayerMarket` while the server's overpayment cap uses `primaryPriceSource` — divergent under the default (`cardmarket`). | Uses `pickMarketPrice(prices, primaryPriceSource)`. |
| `app/(app)/inventory/page.tsx` | QR label sell price ignored `primaryPriceSource` + `marginMultiplier` (diverged from the table); QR fetch and inventory refetch had no error handling. | Uses settings for price; `try/catch` + toasts. |

**Reviewed and confirmed healthy:** the money core (integer pence throughout, guarded
stock decrements, in-transaction credit checks, proportional refund reversal with a
residual cap, integer buy-cap comparison, idempotent offline-sale replay), auth &
DB-backed login lockout, the price-sync engine (page-failure isolation, circuit breaker,
chunking, `Promise.allSettled`), and the **client-bundle boundary** (no client component
value-imports `lib/domain`/`lib/db` — the project's critical rule holds).

**Flagged, deliberately NOT changed (need a decision):**
- **Cost/margin visibility.** Cost price is shown to *all* staff in the inventory table and
  CSV export. Changing only the export would be inconsistent. Decide whether cost/margin
  should be admin-only across **both** the table and export (see F8 below).
- **Global login lockout.** 5 bad PINs lock the whole till for 15 min (owner password
  clears it). Fine for a single physical till; revisit if that becomes a nuisance.
- **No index on `credit_ledger.customerId` / `price_history`.** Full-scan balance sums are
  fine at current scale; add indexes if the ledger grows large.

---

## Part 2 — Missing features / sub-features (prioritised)

Effort: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ 3+ days / needs a spec. "Migration" = new
drizzle-kit migration required.

### P0 — operationally blocking

**F1. Staff management (UI + API).** *(M, migration: none)*
There is **no in-app way to manage staff**. `GET /api/staff` (owner) lists them and
`POST /api/staff` (admin) creates one, but there is **no UI caller for either**, and **no
`PATCH`/`DELETE`** — so you cannot deactivate a departed employee's PIN, reset a forgotten
PIN, or change a role without the `seed-staff.ts` CLI + DB access. For a real shop this is a
security/continuity hole.
- Add `app/api/staff/[id]/route.ts`: `PATCH` (name, role, `isActive`), `PATCH`/sub-route to
  reset PIN (re-hash), guard `requireAdmin`. Keep at least one active admin (guard against
  locking everyone out).
- Add a **Staff** section to Settings (admin): list, add, deactivate, reset PIN, change role.
- Tests for the role/active/PIN-reset domain rules.

### P1 — important for a UK card shop

**F2. VAT Margin Scheme (second-hand goods).** *(L — needs a spec, migration likely)*
UK shops reselling used cards normally use the **VAT Margin Scheme**: VAT is due on the
*margin* (sale − purchase price) per item, not the full price. The groundwork exists
(`sale_items.cost_at_sale` snapshot; `settings.vat_scheme` comment already lists `'margin'`),
but `computeSaleTotals` only implements `none`/`standard`. Implementing it touches pricing
math, receipts, reporting, and record-keeping (the scheme requires a stock book).
- Extend `vatScheme` to `'margin'`; compute per-line `max(0, price − costAtSale)` × 1/6.
- Handle no-cost lines (can't be in the scheme) and the settings/receipt/report surfaces.
- Write a design spec first — this has tax-compliance implications.

**F3. Link sales to a customer + purchase history.** *(M, migration: add `sales.customer_id`)*
`sales` has **no `customerId`**, so only store-credit sales tie to a customer. Adding an
optional customer to any sale unlocks: purchase history on the customer page, "sold to a
want-list customer", loyalty, and easier returns lookup.
- Migration: nullable `sales.customer_id` → `customers.id`.
- POS: optional `CustomerPicker` at checkout for all payment methods (already required for
  store credit — generalise it).
- Customer detail page: add a Purchases list (currently shows credit ledger + wants only).

**F4. Want-list fulfilment alerting.** *(M–L)*
`want_list.notify` + `fulfilledAt` exist and the wants view computes `inStock`, but nothing
proactively surfaces "a wanted card is now in stock", nor notifies the customer.
- Cheapest first: a **"Wants in stock now"** panel (buys/inventory intake cross-referenced
  against open wants) — no external deps.
- Optional next: email/SMS to the customer (needs a provider + uses `customers.phone/email`).

### P2 — valuable polish / depth

**F5. Cash-up close record.** *(M, migration: add `cash_ups` table)*
The cash-up screen recomputes an expected drawer from an ad-hoc float input; nothing is
persisted, there's no **counted-cash** entry, no **variance (over/short)**, and no end-of-day
close record. Add a `cash_ups` table (date, staff, opening float, counted, expected,
variance, notes) and a "Close day" action. Also let cash-up pick a date (currently today only).

**F6. Split tender / partial payments.** *(L, migration: `sale_payments` table)*
`createSale` takes a single `paymentMethod`. Real tills split cash+card or part-store-credit.
Needs a `sale_payments` child table and checkout UI; touches reporting/cash-up.

**F7. Void a sale (vs. refund).** *(M)*
Only refunds exist. A same-day **void** for a staff mis-ring (full reversal, distinct from a
customer return) plus a void audit trail would be cleaner than forcing every correction
through the refund path.

**F8. Cost/margin role-gating (decision → implementation).** *(S)*
See Part 1. If cost/margin should be admin-only: gate the cost column in `InventoryTable`,
gate `/api/inventory/export` (and the Export button) behind `requireAdmin`, and hide margin
figures for non-admins.

**F9. Reporting extras.** *(M, incremental)*
Have: revenue, gross margin, VAT, by-staff, top cards, today's cash/card, cash-up. Missing:
**inventory valuation** (stock-on-hand at cost & market), **aged/dead-stock** report,
**low-stock reorder list** (data already exists via `lowStockThreshold`), **margin by staff**
(not just revenue), and a **buy-transactions CSV export** to match sales/inventory.

**F10. Live price refresh at POS.** *(S–M)*
`CardResult`'s refresh button is stubbed ("coming in Phase 4"). Wire it to an endpoint that
re-fetches a single card's market price on demand.

**F11. Receipt delivery + sales search.** *(M)*
Printable receipts exist; **email/SMS receipts** do not (needs customer contact + provider).
Separately, returns are found only in the recent-50 list — add **sales history search**
(by receipt #, date, customer, or card).

---

### Suggested order on return
F1 (staff management — blocking) → F3 (customer-linked sales — unlocks F4/F11) →
F8 (quick decision) → F5/F9 (reporting/cash depth) → F2 (VAT margin — spec-first) →
the rest as needed.
