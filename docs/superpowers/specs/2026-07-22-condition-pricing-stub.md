# Stub: condition-based pricing (needs brainstorm → spec)

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md) — "Pricing feature for
conditions": played-condition cards should not price at full market.

## Current state (verified 2026-07-22)

- `inventory_items.condition` exists (NM | LP | MP | HP | DMG — lib/db/schema.ts:45) and is
  set at intake, shown everywhere, printed on QR labels.
- BUT pricing ignores it: `calculateSellPrice(marketPence, overridePence, multiplier)` in
  lib/pricing.ts is condition-blind — every condition of the same card prices at
  market × margin unless the item has a manual `sellPriceOverride`.
- Buy side: `calculateBuyPrice(marketPence, pct)` is likewise condition-blind (buylist offers).
- Sale prices are computed server-side in `createSale` (server-canonical rule); the same
  calculateSellPrice logic is mirrored client-side for display.

## Shape of the likely feature

Per-condition multipliers applied to market price before margin, e.g. NM 100% / LP 85% /
MP 70% / HP 50% / DMG 35% — defaults editable in Settings (per-tenant), applied consistently:
sell price, POS display, price check, buylist offer %, CSV export.

## Open questions for the brainstorm

- One global multiplier table per shop, or per-game later (interacts with multi-game stub)?
- Does `sellPriceOverride` stay absolute (wins over everything)? (Almost certainly yes.)
- Buylist: same multipliers or separate buy-side table? (Shops often use different ladders.)
- Where do multipliers live — `settings` JSON column vs new table? Migration + defaults for
  existing tenants.
- Rounding: pence ceil like margin? Keep "no floats in domain" honest (store multipliers as
  integer percent).

## Constraints

- Money integer pence everywhere; prices server-canonical; client never sends prices.
- `expectedTotal` verification in createSale must keep matching what the POS displayed —
  client display logic and server logic must share one dependency-free module (lib/pricing.ts
  is already client-safe; keep it that way).
- Changed behavior needs colocated tests (pricing + createSale + buylist offer paths).

## Next step

Brainstorming session (superpowers:brainstorming) → spec. Touches the money path, so plan →
implement → review workflow, not a quick patch.
