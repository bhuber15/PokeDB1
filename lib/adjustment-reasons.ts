// Shared between the inventory domain logic (server) and the reason prompt in
// the inventory UI (client) — keep this module dependency-free so it never
// drags the DB client into a browser bundle.
export const ADJUSTMENT_REASONS = ['recount', 'damage', 'lost', 'other'] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]
