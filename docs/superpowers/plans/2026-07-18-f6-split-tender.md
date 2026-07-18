# F6 — Split tender / partial payments (spec + plan)

Status: implemented alongside this doc (Phase 4 stack, PR feat/f6-split-tender).
Context: docs/superpowers/plans/2026-07-07-feature-gap-review.md Part 2, F6.

## Problem

`createSale` takes a single `paymentMethod`; real tills split cash+card or
part-store-credit. Reporting (cash-up, by-payment-method) reads
`sales.payment_method`, so a split sale has nowhere to record that £30 of a
£50 sale arrived as cash.

## Decisions

1. **New `sale_payments` child table** — `id, sale_id → sales.id (NOT NULL),
   method, amount` (integer pence > 0). **Every** new sale writes its payment
   rows here, split or not; this table is the canonical per-method record.
2. **`sales.payment_method` is kept** as a display/grouping summary: the single
   method when there is one payment row, the literal `'split'` when there are
   several. Clients cannot send `'split'` — it is derived server-side.
3. **Backfill in the migration**: `INSERT INTO sale_payments (sale_id, method,
   amount) SELECT id, payment_method, total FROM sales`. After it, "sum
   payments by method" is uniform over old and new data — reporting needs no
   legacy fallback branch.
4. **Input shape** (`CreateSaleInput` / POST /api/sales): either the existing
   `paymentMethod` (exactly as today — kept forever because the POS offline
   queue replays old payloads) or a new `payments: {method, amount}[]`.
   Sending both, or neither, is INVALID_INPUT.
5. **Validation rules** for `payments`:
   - 1–4 lines; each `amount` an integer > 0; methods from the existing set
     (`cash | card | store_credit | other`).
   - `Σ amount` must equal the server-computed total. Checked **after** the
     `expectedTotal` check so genuine price drift still surfaces as
     PRICE_CHANGED, not as a payments mismatch.
   - At most **one** `store_credit` line; if present, `customerId` is required
     and the in-transaction balance check compares against the **credit
     portion**, not the whole total. The ledger debit is the credit portion.
6. **Refunds are unchanged.** Staff already choose the refund method
   (cash/store credit) independently of how the sale was paid; the residual
   cap (Σ refunds ≤ sale.total) already bounds mixed flows.
7. **Voids** (F7) return the store-credit **portion** via the ledger — looked
   up from `sale_payments` instead of assuming all-or-nothing. Works for
   pre-F6 sales through the backfill.
8. **Reporting** moves to `sale_payments` where per-method money matters:
   - `getCashUpSummary.cashSales` = Σ cash payment amounts of non-voided sales
     that day (a £30-cash/£20-card sale puts £30 in the drawer).
   - Sales report `byPaymentMethod` = new domain `getSalesByPaymentMethod`
     grouping `sale_payments` by method (so `'split'` never appears there).
   - Revenue/margin/by-staff aggregates keep reading `sales` — they are
     method-agnostic.
9. **Change given** stays a client-side display concern ("cash received" →
   change), exactly as today: `sale_payments.amount` records what the till
   keeps, not the note handed over.
10. **POS UI**: CheckoutDialog gains a "Split payment" toggle. Split mode
    shows method+amount rows (add/remove, max 4), a live remaining-due
    indicator, and a "rest in cash/card" convenience fill. Store-credit rows
    require picking a customer and respect their balance. Receipt data gains
    the payment breakdown.

## Edge cases considered

- Offline replay of a pre-F6 queued sale → `paymentMethod` path, unchanged.
- Split with credit portion > balance → INSUFFICIENT_CREDIT names the portion.
- Two store-credit lines (same or different customers) → rejected; one
  customer's credit per sale keeps the ledger 1:1 with sales.
- Zero/negative/non-integer amounts, > 4 lines, unknown methods → INVALID_INPUT.
- Payments summing to `expectedTotal` when the server total differs →
  PRICE_CHANGED (server-canonical pricing unaffected by this feature).

## Implementation order (TDD per step)

1. Failing domain tests: split cash+card rows + `'split'` summary; sum
   mismatch; credit-portion rules; single-method regression (payment row
   written); void returns credit portion; cash-up counts cash portion;
   `getSalesByPaymentMethod`.
2. Schema + migration 0019 (table + backfill INSERT).
3. `createSale` accepts `payments`, writes rows, derives summary method.
4. `voidSale` + `getCashUpSummary` + new `getSalesByPaymentMethod` on
   `sale_payments`; sales-report route uses the domain fn.
5. POST /api/sales zod: `payments` array, XOR with `paymentMethod`.
6. CheckoutDialog split UI + receipt breakdown; POS page passes payments.
7. Full `npm test` + lint.
