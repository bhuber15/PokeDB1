# Day-one till fixes — design

**Date:** 2026-08-16 · **Status:** approved in brainstorm · **Deadline context:** pilot shop opens 2026-08-29

Four gaps found by the day-one readiness pass (walking the counter: open → sell → split tender →
mixed basket → buy → return → cash up → wifi drop). Fixes 1–3 are till-correctness changes; fix 4
deliberately hardens the failure mode instead of building full offline (a service worker + offline
pricing collides with the server-canonical price rule and the client-bundle boundary — it gets its
own spec after opening, informed by real outage data).

Decisions taken in brainstorm:
- **Offline scope: harden, don't build.** Full offline till deferred to its own spec.
- **Returns: staff-allowed.** Refund caps + staffId attribution + same-day void limit are the
  fraud controls; a customer waiting on an owner callback is the worse failure at this scale.
- **Product buys are condition-less.** No market price exists for products, so no formula would
  consume a condition; the offered price is the condition assessment.

## Fix 1 — `card` as a refund tender

**Problem.** `lib/domain/refunds.ts` accepts `cash | store_credit` only. Card-terminal refunds get
recorded as cash, so each one over-states expected drawer cash at cash-up by the refund amount.

**Change.**
- `lib/domain/refunds.ts`: `METHODS` gains `'card'`. The store-credit branch is untouched; a card
  refund writes the refund row + restock only (the money moves on the physical card terminal,
  exactly like card sales — PokeDB records that it happened).
- `app/api/refunds/route.ts`: zod `method` enum gains `'card'`.
- `components/reports/RefundDialog.tsx`: third method button, Card.
- **No migration.** `refunds.method` is a TEXT column with no CHECK constraint (comment-documented
  enum, same pattern as `sales.paymentMethod`).
- **Cash-up needs no change** — `getCashUpSummary` already filters `refunds.method = 'cash'`, so
  card refunds fall out of drawer maths correctly by construction. Schema comment on
  `refunds.method` updated to `'cash' | 'card' | 'store_credit'`.

**Tests.** Domain: card refund succeeds, restocks, appears in refund totals, does **not** move the
credit ledger; cash-up summary ignores it; residual cap holds across mixed-method refund sequences
(cash then card then credit never exceeds `sale.total`).

## Fix 2 — staff can work the returns desk

**Problem.** `POST /api/refunds` and `/api/sales/[id]/void` already allow staff, but
`/api/sales/search` and `/api/sales/history` are `requireAdmin` — staff can process a refund in
theory and cannot find the sale in practice. Accidental policy.

**Change (policy: staff-allowed, chosen deliberately).**
- `app/api/sales/search/route.ts` and `app/api/sales/history/route.ts`: `requireAdmin` →
  `requireStaff`. (`/api/sales/[id]/receipt` and `/api/sales/[id]/items` are already
  `requireStaff` — no change.)
- Aggregate reporting stays admin-only: `/api/reports/*` (sales, cash-up, inventory,
  margin-stock-book), `/api/sales/export` paths unchanged.
- Reports page (`app/(app)/reports/page.tsx`): gate admin-only sections (revenue tiles, cash-up,
  stock, exports) behind `useStaffRole()` from `components/shared/SessionProvider.tsx` so a staff
  session sees the sales list + returns desk without a wall of failed fetches. Server routes remain
  the real gate — the client check only controls rendering (existing pattern, per the
  SessionProvider comment).
- Sales search predicate (`lib/domain/sales-search.ts`): add `products.name` alongside `cards.name`
  in the item-name `LIKE` branch so returning a drink doesn't require the receipt number. (The
  result rows already COALESCE product names — only the search predicate is card-only.)

**Tests.** Route-level: staff session can search/list sales; staff still 403s on `/api/reports/*`.
Domain: sales-search matches a product name.

## Fix 3 — buy non-card products on the buylist

**Problem.** `CreateBuyInput['items']` requires `cardId` — sealed/accessories brought in by
customers can't be bought.

**Schema (one migration).** `buy_items` gains nullable `product_id` REFERENCES `products.id`.
Exactly-one-of `cardId`/`productId` is enforced at the domain choke point, not by CHECK — the
established `inventory_items` pattern (a CHECK would rebuild the table on SQLite).

**Domain (`lib/domain/buys.ts`).**
- Items become `{ cardId?, productId?, condition?, quantity, payPrice }`; exactly one id required.
  Product items ignore any client condition and store the `PRODUCT_CONDITION` (`'NA'`) sentinel,
  consistent with `inventory_items`.
- Intake: find the product's single inventory row (unique partial index
  `inventory_items_product_id_unique` guarantees at most one). Merge = quantity increment +
  **weighted-average costPrice**, identical to the card merge path. A product with no inventory
  row cannot occur (createProduct always writes one); a deactivated (`isActive = false`) row is a
  DomainError telling staff to reactivate the product first — not a silent revive.
- The 110% market cap does not apply (products have no `price_cache` row); `marketAtBuy` stays
  null, same as cards with no cached price. Pay price is staff judgement.
- Products must already exist (created via Inventory → Add). Buying a product not yet in the
  system is a two-step on day one; an inline "create product" shortcut is a follow-up if the
  counter feels it.

**API.** `app/api/buys/route.ts` zod: `cardId`/`productId` optional with an exactly-one refine;
`condition` required only for card lines.

**UI.** Buylist page gains product results: reuse the inventory search endpoint's product portion
(products always have an inventory row, so `/api/inventory?q=` finds them regardless of stock
level, including EAN barcode fast-path). Product lines in `BuyCart` show no condition selector;
pay price is a free field as today. `BuySlipDialog` prints the product name; no card label.

**Reads.** Buy CSV export (`getBuyExportRows` in `lib/domain/reports.ts`) and any buy-history
name display: `COALESCE(cards.name, products.name)` via a `products` leftJoin — same shape the
sales side already uses.

**Tests.** Domain: product buy creates buy rows + increments the product inventory row with
weighted cost; mixed card+product buy works; store-credit product buy writes the ledger; two-ids /
zero-ids rejected; deactivated product rejected. Export includes product names.

## Fix 4 — offline: fail loudly and safely (not a PWA)

**Problem.** The localStorage sale queue correctly survives a network blip at checkout (replay on
`online` + 30s tick, `clientUuid` idempotency). But during a real outage, search is dead with no
explanation, refunds/buys fail opaquely, and nothing tells staff what is and isn't safe.

**Changes (no service worker, no new storage, no new dependencies).**
- **Offline banner:** app-wide thin banner (in `app/(app)/layout.tsx` via `useOnlineStatus`):
  "Offline — sales will queue and send when the connection returns. Search, buys and refunds need
  a connection." The existing POS `OfflineChip` stays as the till-local indicator.
- **Honest gating:** while offline — buylist checkout and refund/void confirm buttons disabled
  with an inline "needs a connection" note; POS checkout stays enabled (queueing is the feature)
  and its confirm button reads "Queue sale" so staff know what will happen. POS search input stays
  usable but shows an offline notice instead of a silent empty result.
- **Queue safety:** `beforeunload` warning when the queue holds unsent sales (data already
  survives refresh via localStorage; the warning covers the tab-close/white-screen case so staff
  don't navigate away thinking everything synced).
- **Drill:** `docs/runbooks/wifi-down-drill.md` — one page for the shop: what still works, what
  to pause, what the queue badge means, why not to close the tab, what to check when back online.

**Tests.** Queue persistence round-trip (exists — extend for conflict entries); component tests
for gating where the harness allows; the runbook is reviewed prose, not tested code.

## Out of scope (explicitly)

- Full offline till (service worker, cached catalogue, offline pricing) — own spec, after opening.
- CSV stock import for products (import stays card-only; products are added one at a time).
- Per-staff permission toggles for returns — revisit if staffing grows.
- Buying products that don't exist yet in one step at the counter.

## Sequencing

Four independent PR-sized slices, in risk order: **1 → 2 → 4 → 3** (3 last because it carries the
migration; the live dev DB migration is applied as its own deliberate step per the deploy
contract). `main` stays shippable after each slice.
