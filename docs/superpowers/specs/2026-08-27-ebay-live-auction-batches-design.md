# eBay Live auction batches — design (2026-08-27)

Status: **specced, not scheduled — gated** (see Gates). Supersedes the open questions in
`2026-07-22-live-auction-qr-pull-stub.md`. Settled in a grilling session with Brad 2026-08-27.

## Why

Demand trail: first-shop demo 2026-07-22 ("scan all cards before stream to remove them from
inventory"), go-live interview 2026-08-19 ("Will be doing Ebay Lives"), owner plans **~2
streams/week, ~120 cards/stream** (~240 cards/week through this flow).

The load-bearing discovery: the owner lists **generic placeholder listings** on eBay Live —
buyers see the actual card on video. So eBay's records carry prices but **no card identity**.
Cardtill's ordered batch is therefore the shop's *only* record linking "this card, bought for
X, sold for Y" — the per-item record the VAT margin scheme runs on. This feature is the
shop's auction stock book, not a convenience.

## Gates (decided 2026-08-27 — do not build before one trips)

- **Build** when: the owner's first 3 streams show >30 min of pull/settle faff or one
  near-double-sell, **or** ≥3 of the first 10 founding interviews run or concretely plan
  lives. At 2 streams/week the window is ~10 days from their first stream.
- **Shelve** when: 3 streams run clean on the workaround.
- **Pre-work shipping independently next week (not gated)**: add `sold-elsewhere` to
  `ADJUSTMENT_REASONS` (`lib/adjustment-reasons.ts`) + reason label + its own line in
  reports. It is the interim workaround, the v1 fallback for anything out of scope below,
  and its usage count is demand telemetry for this very gate.
- **Owner conversation agenda** (next visit): usage commitment for N streams, folded into
  the founding-£99 conversation; confirm whether they have ever actually run an eBay Live
  (assumed: not yet).

## The workflow (settled)

1. **Create batch**: search/select or QR-scan items into a named batch. Batch order = auction
   sequence, reorderable; positions numbered 1..N; cards physically numbered to match.
   (Scanner plumbing already exists — see stub. Optional nicety: numbered batch label sheet
   reusing `lib/printLabelSheet.ts`.)
2. **Hold**: batch creation moves stock sellable → held. A till scan of a held item **blocks
   the sale**: "Held for auction batch <name> — release?" with a one-tap deliberate release
   (audited: who/when). A soft badge was considered and rejected — a warning nobody reads
   under till pressure is no warning. Held items stay visible on the inventory page, badged.
   Partial holds of multi-quantity rows supported (hold qty per batch item).
3. **Run sheet**: the ordered list, on screen and printable, for use during the stream.
4. **Settlement**: after the stream, enter prices down the numbered list; partial settlement
   allowed. Each position → **sold at gross hammer price** or **no-sale → auto-return to
   stock**. Lots: select N positions → one price → split across items largest-remainder in
   integer pence (data model: a settlement line may cover N items). A batch may only close
   when **every position is disposed** (sold / returned / released); open batches are loudly
   visible.
5. **Recording**: settlement writes real sales with `channel = 'ebay_live'`. Deliberate,
   documented carve-out from the server-canonical price rule: hammer prices are externally
   determined, entered at settlement; the `expectedTotal` verification flow does not apply.
   Refunds of `ebay_live` sales are **rejected** (drawer never held that money); an eBay
   return is a manual restock adjustment. Lean toward reusing `sales`/`sale_items` + a
   `channel` column over parallel tables — final call at build time.
6. **Reports**: sales reports gain a channel split line; **cash-up counts `channel='till'`
   only**. Report bucketing stays on UTC days per the house day-window rule; auction sales
   bucket by settlement time, not stream time — accepted.

## Price-capture ladder (decided)

- **v1 — manual**: type ~120 prices down the numbered list (~25 min/stream). Works for
  stream one, works for consignment, zero eBay dependency.
- **v1.5 — CSV**: import the Seller Hub sold-orders export, matched by number-in-title or
  by timestamp sequence (30 s cadence ⇒ sequential). Only after seeing one real export from
  the owner's actual account.
- **v2 — API**: one Cardtill app on the eBay Developers Program; each shop grants OAuth
  consent ("Connect eBay"), per-tenant refresh tokens; poll the Fulfillment API for orders.
  Gated on **several paying tenants streaming regularly**. Note eBay's application growth
  check reviews a *working* app, and the API only ever reads results — it never runs the
  auction. Everything it does, the CSV also does.

## Out of scope

- Creating or syncing eBay listings (generic listings make export pointless; marketplace
  listing sync stays the separate parked Pro-tier decision — `lib/plan.ts` `listingSync`).
- Fees and payout reconciliation — gross hammer only; fees live in eBay statements and the
  accountant's world. The bank payout will not equal the sum of hammers; Cardtill does not
  try to explain the difference.
- eBay buyer records, postage, returns automation, bundle UI beyond multi-select lot
  settlement.

## Schema (build-time decisions resolved 2026-08-27 — see the implementation plan)

Plan: `docs/superpowers/plans/2026-08-27-ebay-live-auction-batches.md`.

- `auction_batches` (id, name, status `open|settled`, createdByStaffId, saleId, createdAt,
  settledAt) — one `channel='ebay_live'` sale written atomically at close.
- `auction_batch_items` — **one row per physical card** (no qty column; pulling 2 copies =
  2 rows, so partial holds and per-card positions fall out for free): batchId, position,
  inventoryItemId, disposition `pending|sold|unsold|released`, soldPrice, lotKey, release
  audit fields. "Unsold" stock returns to sellable *at close* (settlement entries stay
  freely editable until then); "released" (till rescue) unholds immediately.
- `inventory_items.held_quantity` (int, default 0) — sellable = quantity − held; keeps
  `createSale`'s guarded-UPDATE stock check a plain column comparison. Invariant (held =
  pending rows in open batches) maintained transactionally, defended by domain tests.
- `sales.channel` text notNull default `'till'`.
- One till deviation, on purpose: `marginNoCostHandling='block'` never blocks a batch
  close (the auction already happened; blocking would strand physical stock) — close
  always uses exclude-and-warn and returns `marginNoCostCount`.
- Any constants shared with the UI (channel labels, dispositions) go in a dependency-free
  module per the `lib/adjustment-reasons.ts` pattern (client-bundle boundary).

## Money & VAT (research resolved 2026-08-27, against VAT Notice 718 guidance)

All integer pence. Record **gross hammer per item**. Findings:

- **Postage counts, but stays out of Cardtill.** Margin-scheme selling price is everything
  received for the goods, *including* incidental expenses charged to the buyer (postage,
  packing). v1 still records hammer only: postage totals live in eBay's statements and the
  accountant combines them at VAT-return time. The eBay Live report line must therefore be
  labelled "hammer totals, excl. postage" so it is never mistaken for the VAT-return figure.
- **Global Accounting is the likely fit.** The margin-scheme variant for items *purchased*
  at ≤£500 each: VAT due on period totals (total eligible sales − purchases), negative
  margin carries forward, no per-item sale↔purchase linkage required. Card volume fits it
  naturally. Per-item hammer records *exceed* its requirements, and buylist purchase records
  satisfy both variants — so recording gross hammer per item keeps the shop compatible with
  either choice. **Which variant the shop uses is their accountant's call, not Cardtill's.**
- **The Auctioneers' Scheme (718/2) does not apply** — the shop sells its own stock; eBay is
  the venue, not an auctioneer selling on the shop's behalf.
- Settlement sales must flow through the **same VAT-scheme setting as till sales**
  (`lib/settings.ts` — house rule: check it before touching tax logic), so the settled
  batch's sale applies identical margin computation to a till sale.

## Testing (contracts, colocated)

- Hold blocks `createSale` for held qty; release restores; partial holds on multi-qty rows.
- Disposal invariant: batch cannot close with a pending position; no-sale returns stock.
- Lot split: pence-exact, largest-remainder, sums to the entered price.
- `ebay_live` sales excluded from cash-up, included in report channel split.
- Refund of an `ebay_live` sale rejected.
- Settlement endpoint idempotent on retry.
- Till e2e: the block-with-release dialog is a till workflow change — extend the existing
  checkout smoke when building; no new per-feature specs.

## Estimate

Single-phase slice, ~1 week: migration + domain (batch lifecycle, hold enforcement in the
sale path, settlement money rules) + UI (batch screen, settlement screen, till block dialog,
reports line).
