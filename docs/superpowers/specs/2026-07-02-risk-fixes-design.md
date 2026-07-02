# PokeDB — Architectural Risk Fixes
**Date:** 2026-07-02
**Status:** Approved
**Scope:** Four sequential work packages fixing the risks identified in the 2026-07-02 architectural review: domain-layer extraction with server-side pricing (A), integer pence + VAT groundwork (B), price history + resilient sync (C), minimal offline sale queue (D).

---

## Context and decisions

From the architectural review, seven risks were identified. They decompose into four packages, executed in order A → B → C → D. Decisions made during brainstorming:

| Decision | Choice |
|---|---|
| Offline scope | Minimal sale queue only. Full offline-first PWA (service worker, cached images, offline search) is **formally descoped** — this spec supersedes §6 of `2026-06-29-pokedb-pos-design.md`. |
| VAT status | Shop is **not VAT-registered**. Sales record `vatScheme: 'none'` deliberately; a settings field makes future registration a config change. Margin-scheme math is not built. |
| Data reality | Pre-launch; DB holds test data only. The pence migration is a plain ×100 conversion, no backup ceremony. |
| Haggling model | Whole-sale discount only. Line prices are always server-canonical; negotiation goes through the existing per-sale discount field. |
| Domain shape | Plain transactional functions in `lib/domain/`, not classes/repositories. |
| Money unit | Integer pence, same column names. |
| Offline storage | localStorage, not IndexedDB. |

---

## Package A — Money-core hardening

**Fixes:** business logic in route handlers; client-trusted prices; untested money paths.

### `lib/domain/` — three transactional functions

Each function owns validation, one DB transaction, and typed errors. Each accepts an optional db handle (defaulting to the app's `lib/db` client) so tests can inject an in-memory database.

**`createSale(input, dbc?)`**
```ts
input: {
  staffId: number
  items: { inventoryItemId: number; quantity: number }[]
  paymentMethod: 'cash' | 'card' | 'store_credit' | 'other'
  discount: number             // package A: pounds (current unit); package B renames to discountP (pence)
  customerId?: number          // required for store_credit
  expectedTotal: number        // total the till displayed; becomes expectedTotalP in package B
  clientUuid?: string          // added in package D
}
returns: { saleId: number; total: number }  // total becomes totalP in package B
```
- The client **never sends prices**. For each line the server computes the canonical unit price: `sell_price_override` if set, else `pickMarketPrice(price_cache, settings.primaryPriceSource) × settings.marginMultiplier`, else error `NO_PRICE` (item has no override and no cached market price — staff must set an override).
- Discount is clamped to `0…subtotal`.
- If computed total ≠ `expectedTotalP` → error `PRICE_CHANGED` (409). The till re-fetches prices and re-presents the checkout.
- Stock decrement keeps the existing guarded-UPDATE pattern (quantity can never go negative).
- Store-credit balance check moves **inside** the transaction (currently a pre-transaction race).
- Snapshots `cost_at_sale` per line from the inventory item's `cost_price` (column added here; unit converts in B).
- VAT: records `vatScheme` from shop settings (see B); `'none'` → 0.

**`createRefund(input, dbc?)`** — logic moved verbatim from `app/api/refunds/route.ts` (it is already correct and transactional). Error strings become `DomainError`s.

**`createBuy(input, dbc?)`** — logic moved from `app/api/buys/route.ts`. Same treatment.

### Errors

```ts
class DomainError extends Error {
  code: 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'INSUFFICIENT_CREDIT'
      | 'NO_PRICE' | 'BAD_LINE' | 'NOT_FOUND' | 'INVALID_INPUT'
      | 'UNAUTHORIZED' | 'FORBIDDEN'
  meta?: Record<string, unknown>   // e.g. { inventoryItemId }
}
```
Routes map codes → HTTP status (`INVALID_INPUT` 400, `NOT_FOUND` 404, conflict-class codes 409). Unknown errors stay 500 with a generic message.

### Routes and auth

- `app/api/sales`, `app/api/refunds`, `app/api/buys` shrink to: parse → auth → call domain → map result/error.
- `lib/auth.ts` gains `requireStaff(session)` and `requireAdmin(session)` returning the session or throwing `DomainError('UNAUTHORIZED')` / `DomainError('FORBIDDEN')`, mapped to 401/403 by the same route-level error mapping. All API routes adopt them — no more hand-rolled variants.

### Tests (TDD, written before each function lands)

- Runner: existing `npm test` (`node --import tsx --test`).
- Harness: `lib/db/test-helpers.ts` creates an in-memory libSQL client (`:memory:`) and applies the SQL files from `lib/db/migrations/` in journal order.
- Invariants covered: stock never negative (including concurrent-style repeated calls), credit never overspent, refund quantity caps (incl. multiple lines referencing one sale item), totals reconcile (subtotal − discount + VAT = total), `PRICE_CHANGED` fires on stale totals, `NO_PRICE` fires on unpriced items, idempotent replay (added in D).
- UI stays manually tested; a full browser verification pass happens after package D (the SDD ledger already requires it).

## Package B — Money correctness

**Fixes:** float money; VAT structurally unfinished.

### Integer pence

- Every money column converts `real` → `integer` (pence), keeping its name: `inventory_items.cost_price`, `inventory_items.sell_price_override`, all seven price columns on `price_cache`, `sales.{subtotal,discount_amount,vat_amount,total}`, `sale_items.price_at_sale`, `sale_items.cost_at_sale`, `refunds.amount`, `credit_ledger.delta`, `buy_transactions.total`, `buy_items.pay_price`, `settings.high_value_threshold`.
- Ratios stay `real`: `margin_multiplier`, `usd_to_gbp`, `eur_to_gbp`, `buy_cash_pct`, `buy_credit_pct`.
- Migration: `UPDATE t SET col = CAST(ROUND(col * 100) AS INTEGER)` per column (SQLite tolerates the type change; Drizzle schema changes to `integer`).
- `lib/pricing.ts` reworks to pence in/pence out: `calculateSellPrice`, `calculateBuyPrice`, `usdToGbp`, `eurToGbp` return integer pence (ceil for sell, floor for buy, round for FX — preserving current rounding directions). `formatGBP(pence)` becomes the **only** pence→pounds conversion; a `parsePounds(input): pence` helper is the only pounds→pence path for form inputs.
- All UI money inputs/outputs and the CSV import/export convert at the boundary via those two helpers. CSV files keep pounds (human-facing format unchanged).
- `round2` disappears from money paths (integer arithmetic; proportional splits use integer math with largest-remainder rounding where needed — the refund VAT ratio becomes `amountP = round(netP × sale.totalP / sale.subtotalP)`).

### VAT groundwork

- `settings.vat_scheme` text column, default `'none'`, allowed `'none' | 'standard'`. `createSale` reads it; `'standard'` applies 20% on the post-discount amount (existing math, now pence). Margin scheme is **not** implemented — becomes possible later because `cost_at_sale` exists (from A).
- Settings UI gains the field (admin-only, existing page).

## Package C — Pricing infrastructure

**Fixes:** serial fragile sync; no price history.

- New table `price_history`: `id, card_id FK, cardmarket_trend, tcgplayer_market, recorded_on (text date 'YYYY-MM-DD')`, unique `(card_id, recorded_on)`, money in pence.
- `syncCardmarketForCard` upserts the `price_cache` row (insert if missing — fixes the silent no-op) and inserts today's `price_history` row with insert-or-ignore.
- Cron route processes cards in concurrent batches of 8 with per-card failure isolation (`Promise.allSettled`); returns `{ synced, failed }`. After syncing, deletes `price_history` rows older than 90 days.
- No trend UI in this package — capture only.

## Package D — Minimal offline sale queue

**Fixes:** total network dependence of the till. Supersedes the original spec's offline-first PWA design.

- `sales.client_uuid` text unique nullable. `createSale` with a `clientUuid` it has already stored returns the original `{saleId, totalP}` instead of re-executing (idempotent replay).
- POS checkout: generate `crypto.randomUUID()` per checkout attempt. On **network failure only** (fetch rejects — not HTTP error responses), the sale payload is appended to a localStorage queue (`pokedb.saleQueue`), the cart clears, a toast says "Offline — sale queued". Staff keep selling from already-loaded search results.
- Replay: on `online` event and a 30s interval while the queue is non-empty, POST each queued sale in order through the normal endpoint. Success removes it from the queue. `INSUFFICIENT_STOCK`/`PRICE_CHANGED` responses mark the entry `conflict: true` — it stays visible in a queue badge on the POS page for a human to resolve (retry after restock, or discard). Conflicts are never auto-resolved.
- Known accepted limitation: stock validation happens at replay time; two tills selling the same last copy offline produces one conflict entry, by design.
- Update `2026-06-29-pokedb-pos-design.md` §6 with a pointer to this spec (descope note).

---

## Execution

- Four separate implementation plans (one per package), executed sequentially A → B → C → D on this branch or a successor, via subagent-driven development with per-task code review, ponytail mode for code writing, TDD for all `lib/domain/` and `lib/pricing.ts` work.
- After D: manual browser verification pass covering POS sale (incl. offline queue + replay), refund, buy, CSV import/export, reports, settings — the pass the SDD ledger already mandates.

## Out of scope

- Margin-scheme VAT math (groundwork only: `cost_at_sale`, settings field).
- Full offline PWA (service worker, cached images, offline search/prices, offline buys/stock edits).
- Any new features (sealed products, till reconciliation, price-trend UI, wants matching) — tracked separately from the review's "next features" list.
