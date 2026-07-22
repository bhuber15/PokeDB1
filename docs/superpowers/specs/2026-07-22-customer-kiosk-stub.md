# Stub: customer-facing kiosk tablet (needs brainstorm → spec)

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md), flagged "IDEA":
a display tablet in the shop for customers. Customer enters their details → becomes a
customer record usable at the POS; they pick cards ("select all the ones they want"), the
list lands on the POS, and the kiosk "shows them a potential estimate".

**Ambiguity to resolve first in the brainstorm:** "ones they want" + "estimate" reads most
naturally as **buylist intake** (customer queues up cards they're SELLING to the shop and
sees an indicative offer) — that's the counter bottleneck a kiosk kills. But it could also
mean browsing shop stock and building a purchase/want list. Design for the buylist reading,
keep the browse/want reading as a cheap secondary mode if the architecture allows.

## Current state (verified 2026-07-22)

- `customers` + `credit_ledger` exist; customer create/edit is staff-side only.
- Buylist flow (app/(app)/buylist, lib/domain/buys.ts) is staff-driven: search catalogue,
  offer = market × buy %, on-demand price refresh (PR #18). No queue/draft concept.
- `want_list` exists with in-stock matching (F4) and an unwired notification seam
  (lib/domain/wants.ts).
- Auth is owner-password/staff-PIN sessions — there is NO unauthenticated or customer-facing
  surface at all today. A kiosk is a new trust boundary (locked-down tablet in shop, no staff
  session).

## Open questions

- Kiosk auth: device-scoped token (new role) vs anonymous + per-submission claim at the till.
- Estimate honesty: buy prices are server-computed; the kiosk must show "indicative, subject
  to condition check" — condition is graded by staff, not the customer (interacts with the
  condition-pricing stub).
- Data protection: customer self-entry (name/email/phone) on a shared device — GDPR wording,
  auto-clear between customers, no browsing other customers' data.
- Delivery to POS: polling vs push; a "pending kiosk submissions" queue on the buylist screen.
- Hardware: cheap Android tablet in kiosk browser mode is probably enough (PWA-ish page).

## Constraints

- Money integer pence; offers server-canonical; store-credit payouts require customerId.
- New routes guarded() + zod; multi-tenant: getTenantDb() everywhere.

## Next step

Brainstorming session (superpowers:brainstorming) → spec. Confirm the buylist-vs-browse
reading with the pilot shop before building anything.
