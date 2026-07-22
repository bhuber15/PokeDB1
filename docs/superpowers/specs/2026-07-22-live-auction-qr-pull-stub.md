# Stub: live-auction stock pull via QR scan (needs brainstorm → spec)

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md). Shop runs live-stream
auctions (Whatnot-style). Ask: before a stream, scan every card going on stream to remove it
from sellable inventory, so the till can't double-sell it mid-stream. Their note: "figure how
scanner would actually work".

## How scanning already works (verified 2026-07-22 — answer given inline in triage)

- Every inventory item already has a unique `qrCode` (UUID, lib/db/schema.ts:49) and a
  printable QR label (components/inventory/QRLabel.tsx, GET /api/inventory/[id]/qr).
- The POS SearchBar (components/pos/SearchBar.tsx) is scanner-ready: a USB/BT handheld scanner
  acts as a keyboard (types the decoded text + Enter). Input matching a UUID triggers
  `onQRDetected` → GET /api/inventory?qrCode=… → exact item. PR #33 added scanner-safe
  refocus so scan→add→scan runs hands-free.
- So the hardware story is solved; the missing piece is a **destination** for "pull for
  stream" scans — today a scan only adds to a sale cart.

## Shape of the likely feature

An "auction pull" (stock hold) mode: scan items into a named batch → quantity moves from
sellable to held; after the stream, mark each held item sold (batch sale at hammer price —
prices vary per lot, so likely manual price entry) or return it to stock. Needs an audit
trail (who pulled, when, which stream).

## Open questions for the brainstorm

- New `stock_holds` table vs adjustment-reason ledger entries? (Refund/void interplay.)
- Selling a held item: through createSale with per-lot price override, or a dedicated
  "auction settlement" flow? (Server-canonical price rule needs a deliberate carve-out —
  hammer price IS the price; maybe model as sellPriceOverride set at settlement.)
- Multi-quantity rows: pulling 2 of a 5-stack (partial holds).
- Does held stock still show on the inventory page (badged) and in wants-in-stock matching?
- VAT margin scheme on auction sales (same as till?).

## Constraints

- Money integer pence; append-only ledgers preferred (see credit_ledger precedent).
- Domain logic in lib/domain/ with tests; routes guarded() + zod.

## Next step

Brainstorming session (superpowers:brainstorming) → spec. Contained enough for a single-phase
build once specced.
