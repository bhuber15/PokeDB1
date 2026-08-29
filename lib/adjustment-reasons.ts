// Shared between the inventory domain logic (server) and the reason prompt in
// the inventory UI (client) — keep this module dependency-free so it never
// drags the DB client into a browser bundle.
//
// 'sold-elsewhere' records off-till sales (eBay Live streams, online orders)
// until they get a first-class flow — its usage count is the demand signal
// for the auction-batch feature (docs/superpowers/specs/2026-08-27-ebay-live-
// auction-batches-design.md), so keep it distinct from 'other'.
export const ADJUSTMENT_REASONS = ['recount', 'damage', 'lost', 'sold-elsewhere', 'other'] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  recount: 'Recount',
  damage: 'Damage',
  lost: 'Lost',
  'sold-elsewhere': 'Sold elsewhere',
  other: 'Other',
}
