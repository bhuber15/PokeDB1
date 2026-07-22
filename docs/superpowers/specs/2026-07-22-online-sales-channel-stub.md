# Stub: online sales channel (needs brainstorm → spec)

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md) — "Want to do online".
Interpreted as: sell the shop's inventory online, not just over the counter. (If Brad meant
something narrower — e.g. just a public stock list — the brainstorm should confirm early.)

## Current state (verified 2026-07-22)

- Inventory is single-channel: `inventory_items.quantity` is the shop-floor truth; sales only
  happen through the POS (`createSale`, server-canonical prices).
- There is already a public-ish read path precedent: want-list + catalogue browsing exist
  in-app; nothing is exposed unauthenticated.
- Platform layer (multi-tenant SaaS, Phase 0–3 merged) means "online store per tenant" is a
  product decision, not a one-off: subdomain-per-shop already exists in `proxy.ts`.
- Full-shop zip export + Stripe billing exist; no e-commerce, no shipping, no online payments
  for shop customers.

## Options to weigh in the brainstorm

1. **Own storefront** per tenant (public subdomain page + basket + Stripe Checkout; inventory
   reservation vs oversell; shipping/pickup).
2. **Marketplace integrations** (UK: eBay, Cardmarket) — export/sync stock, import orders,
   decrement inventory. Less UI, hard sync problems (Cardmarket API access is restricted).
3. **Read-only web stock list** with "reserve for pickup" — smallest honest step, no payments.

Key risks: double-sell between till and web (needs reservation/holds in the domain layer),
price staleness online vs server-canonical rule, VAT margin scheme on shipped orders, and
refunds/credit interplay.

## Constraints

- All money integer pence; prices server-canonical; VAT scheme setting applies in createSale.
- Multi-tenancy: any public route must resolve tenant via getTenantDb() — no db singleton.
- Vercel deploy model (see docs/runbooks/); crons already budgeted.

## Next step

Brainstorming session (superpowers:brainstorming) — decide the channel strategy (1/2/3 or
phased), then a full spec. This is a large, multi-phase feature; do not start without a spec.
