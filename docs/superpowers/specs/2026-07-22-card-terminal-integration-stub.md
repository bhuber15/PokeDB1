# Stub: card payment terminal integration (needs brainstorm → spec)

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md) — "Want to connect it
to their card payment system".

## Current state (verified 2026-07-22)

- `sales.payment_method` is just a recorded label ('cash' | 'card' | 'store_credit' | 'other',
  lib/db/schema.ts:96; split-payment rows since migration 0019). Staff key the amount into
  their standalone card terminal by hand, then mark the sale as "card" in PokeDB. No
  integration, so typo/skim risk and no reconciliation.

## What "integration" means (options for the brainstorm)

1. **Stripe Terminal** (WisePOS E etc.) — first-class API, server-driven amounts, fits the
   existing Stripe platform billing account story; but shops already own hardware and pay
   existing acquirer fees.
2. **SumUp / Zettle / Square REST or app-switch APIs** — the terminals UK card shops actually
   have; per-provider adapters, varying API quality.
3. **No hardware API** — "terminal-first" reconciliation: record the terminal's transaction
   reference against the sale + end-of-day cash-up matching (cash_ups domain exists).

Which providers do pilot shops actually use? (Ask them — likely SumUp or Zettle.) A pluggable
`payment_provider` seam with one real adapter beats five half-adapters.

## Open questions

- Failure modes: terminal timeout after sale committed (needs pending-payment state in
  createSale? today the sale is atomic).
- Refunds through the terminal vs manual (refunds are capped server-side already).
- SaaS: per-tenant provider credentials storage/encryption; plan gating (lib/plan.ts).
- Does this change cash-up reconciliation (lib/domain/cash-ups.ts)?

## Constraints

- Money integer pence; sale totals server-canonical; sale atomicity vs external payment
  confirmation needs explicit state design — this touches the most sensitive domain path.

## Next step

Brainstorming session (superpowers:brainstorming) → spec, starting with which terminal the
pilot shop owns. High blast radius; full plan → implement → review workflow.
