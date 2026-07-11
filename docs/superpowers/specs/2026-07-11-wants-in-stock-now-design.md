# F4 — Wants in stock now (design)

Date: 2026-07-11
Feature ref: `docs/superpowers/plans/2026-07-07-feature-gap-review.md` § F4

## Goal

Make the shop-wide want list **proactive**: surface which wanted cards are sellable
right now and who to phone, in the place the owner already looks (the Customers →
Want List view), plus a nav badge that flags it at a glance.

**Phase 1** (this build): the in-stock surface + contact info + nav badge. No external deps.
**Phase 2 scaffold** (this build): the `notify` toggle and a single notification seam,
so wiring a real email/SMS provider later is a small drop-in — **no paid provider is wired now.**

## Current state (what already exists)

- `want_list` has `notify` (bool, default `true`) and `fulfilledAt` (nullable text). No
  migration is needed.
- `customers` has nullable `phone` and `email`.
- `GET /api/wants` (`app/api/wants/route.ts`) already returns every open want
  (`fulfilledAt IS NULL`) joined with customer **name** + card info, and computes an
  `inStock` boolean per want from active `inventory_items`. The query + `inStock`
  computation currently lives **inline in the route**.
- `WantsPanel` (`components/customers/WantsPanel.tsx`) renders that flat list shop-wide
  behind a "Want List" toggle on `app/(app)/customers/page.tsx`. It shows a green
  "In stock" badge but: mixes in/out-of-stock rows, shows only the customer *name*
  (no phone/email), is one row per want (not grouped by card), and is not discoverable
  (no badge/alert).

## Scope decisions (agreed with owner)

- **Placement:** enhance the existing Want List view in place (not a new `/wants` route,
  not a dashboard).
- **Scope:** Phase 1 + Phase 2 scaffold (notification plumbing without a real provider).

## Design

### 1. API — `GET /api/wants` (enrich + thin the route)

- Add `customerPhone` and `customerEmail` to each returned want (the join already hits
  `customers`; add two selected columns). This answers "who do I call".
- Move the query + `inStock` computation **out of the route into `lib/domain/wants.ts`**;
  the route delegates. Satisfies AGENTS.md "routes stay thin, logic in `lib/domain/`".
- Add **`PATCH /api/wants?id=<n>`** to toggle `notify`. Guarded via `guarded()`,
  body validated with a zod schema via `parseBody()`, delegates to
  `setWantNotify(id, notify, db)`. *(Phase 2 scaffold.)*
- `POST` and `DELETE` handlers are unchanged. `DELETE` already sets `fulfilledAt`
  (this is the "mark fulfilled" action).

Response shape per want (superset of today's):

```ts
{
  id, customerId, cardId, freeText, notify, createdAt,
  customerName, customerPhone, customerEmail,   // customerPhone/customerEmail are new
  cardName, cardSetName, cardSetNumber,
  inStock,
}
```

### 2. Domain — `lib/domain/wants.ts` (+ colocated `wants.test.ts`)

All functions take an optional `Db` handle (default to the shared `db`) per the domain
convention, and throw `DomainError(code, message)` for expected failures.

- `listOpenWants(db?)` — the enriched query moved out of the route. Returns open wants
  with customer contact + card info + `inStock`. `inStock` is `true` only when the want
  has a `cardId` and at least one **active** `inventory_items` row exists for that card.
- `countInStockWants(db?)` — count of open wants that are in stock (for the nav badge).
  A focused query, not a re-filter of the full list.
- `setWantNotify(id, notify, db?)` — updates `notify`; throws
  `DomainError('want_not_found', …)` when no open want with that id exists. Returns the
  updated row (without leaking anything sensitive — wants have no secrets).
- `sendWantInStockNotification(want, db?)` — **the single Phase-2 seam.** No provider is
  wired, so it returns `{ sent: false, reason: 'provider_not_configured' }`. This is the
  one place a real email/SMS provider drops in later. ~10 lines, unit-tested for the
  not-configured result. It does **not** send anything and is **not** called from any
  route in this build — it exists purely as the documented extension point.

Tests (`wants.test.ts`, in-memory DB via `createTestDb()`):
- `inStock` true when an active inventory item exists for the card; false when the only
  inventory row is inactive or is for a different card.
- Free-text wants (no `cardId`) are never in stock.
- Fulfilled wants (`fulfilledAt` set) are excluded from `listOpenWants` / count.
- `countInStockWants` matches the number of in-stock wants.
- `setWantNotify` flips the flag; throws `want_not_found` for a missing/fulfilled id.
- `sendWantInStockNotification` returns `{ sent: false, reason: 'provider_not_configured' }`.

### 3. Pure grouping helper — `lib/wants-grouping.ts` (+ colocated test)

Dependency-free module (no `lib/db` / libsql import) so the **client** `WantsPanel` can
value-import it without breaking the client bundle — mirrors `lib/adjustment-reasons.ts`.

- Exports a `Want`-shaped type (the API row) and
  `groupInStockWants(wants): InStockCardGroup[]`.
- Includes only wants where `inStock === true` **and** `cardId != null`.
- One `InStockCardGroup` per `cardId`, carrying a display label (name / set / number)
  and `customers: { customerId, wantId, name, phone, email, notify }[]`.
- Deterministic ordering (e.g. by card label, then customer name) so tests are stable.

Test (`wants-grouping.test.ts`): multiple customers collapse under one card; out-of-stock
and free-text wants are excluded; ordering is stable.

### 4. UI — enhance `WantsPanel` in place

- New top section **"In stock now — ready to sell"**: one card per `InStockCardGroup`.
  Each card shows the card label and, per interested customer: name (linked to the
  customer), **phone**, **email**, a `notify` toggle (PATCHes `/api/wants?id=`), a
  **"Sell →"** link (`/pos?q=<cardName>`, as today), and **"Mark fulfilled"**
  (DELETE, as today). Empty state: "No wanted cards are in stock right now."
- Below it: the existing full open-wants table, unchanged.
- The panel fetches `/api/wants` once (now including contacts) and derives the grouped
  section client-side via `groupInStockWants`.
- `WantsPanel.test.tsx` updated to cover the in-stock section rendering (contacts shown,
  grouping) and the `notify` toggle call.

### 5. Nav count badge

- `app/(app)/layout.tsx` is an async server component; it calls `countInStockWants(db)`
  and passes `inStockWantsCount` to `<Nav>`.
- `Nav` renders a small count `Badge` on the **Customers** link when the count is `> 0`.
  Computed server-side per navigation — no client polling. When the count is `0`, no
  badge renders.

### 6. No migration

`notify` and `fulfilledAt` already exist in `want_list`. Nothing to generate.

## Non-goals (Phase 2, deferred)

- Actually sending email/SMS (needs a provider + the owner's go-ahead on cost).
- Auto-marking `fulfilledAt` on notification.
- Any batching/scheduling of notifications.

## Constraints honoured (AGENTS.md)

- Business logic in `lib/domain/` with optional `Db` handle + `DomainError`; routes stay
  thin (`guarded()` + `parseBody()`).
- The client component value-imports only the dependency-free `lib/wants-grouping.ts`
  (and `import type` for the row shape) — never `lib/domain/*` or `lib/db`.
- No money is involved; nothing to convert.

## Done-gate

New `lib/domain/wants.test.ts` and `lib/wants-grouping.test.ts`, updated
`WantsPanel.test.tsx`; then `npm test`, `npm run lint`, `npx tsc --noEmit`, and
`npm run build` all green.
