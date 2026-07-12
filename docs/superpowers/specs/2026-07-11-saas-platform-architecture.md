# SaaS Platform Architecture — research synthesis & build plan (2026-07-11)

Source: the 12-agent research pipeline in `Research/outputs/` (00-MASTER-PLAN plus reports
01–12), synthesised against the current build. This spec is the answer to: *what does the
research say, what already exists, what's missing, and what architecture gets us there.*

---

## Part 1 — What the research concludes (synthesis)

The 12 reports converge on one plan with unusual consistency:

**The business**: pivot PokeDB from a single shop's POS into **"Idea 1: UK Niche
Domination"** — a multi-tenant B2B SaaS for UK TCG shops. Tiers £39 (Starter) / £79
(Growth) / £149 (Pro), 14-day card-less trial, no transaction fees. Realistic target: 80
shops / £6.6K MRR by Month 12; infra breakeven at ~4 shops. The window exists because
BinderPOS closed to new customers (Feb 2025) and no competitor is UK-first, VAT-native, or
Cardmarket-priced. Year-2 evolution (explicitly *not* now): Stripe Connect payment
processing and Cardmarket/eBay listing sync as a Pro feature.

**The sequence** (validation before code — every report repeats this):
1. **Weeks 1–3**: rename/brand, landing page, 100+ cold emails, 8–10 interviews,
   **Wizard-of-Oz beta** — 3 shops on separate single-tenant deployments of the *existing*
   codebase. Kill/continue gate at Week 3.
2. **Weeks 4–9**: the SaaS build — multi-tenancy, Stripe Billing, provisioning, admin
   dashboard, monitoring. Tech report estimates 4–6 weeks for one developer.
3. **Weeks 10–13**: growth. Feature roadmap thereafter is driven by paying-customer
   requests, not speculation.

**Non-negotiables the research flags**:
- **Rename before any public presence.** "PokeDB" invites a Nintendo/TPC cease-and-desist
  (legal report rates this the one CRITICAL item). Product name, domain, marketing —
  and in code, anything user-visible.
- **Database-per-tenant on Turso** (not shared-schema+tenant_id): complete isolation,
  GDPR deletion = delete one file, Turso schema propagation for migrations, EU (Frankfurt)
  region for data residency.
- **Stripe Billing** for subscriptions (not Paddle/GoCardless at launch); customer portal
  so no billing UI is built; webhook-driven tenant lifecycle.
- **Keep iron-session** — no Clerk/Auth0. Extend the session with tenant identity.
- **Revenue must not wait for multi-tenancy**: Wizard-of-Oz single-tenant deployments are
  the fallback at every stage (risk report caps this at ~10 manual shops).
- **Ops floor**: Sentry, UptimeRobot on a health endpoint, automated backups, P1 =
  30-minute response. GDPR: DPA per shop, sub-processor list, exportable/deletable data.

**Key correction to the research** (it underestimates the build): the tech report assumes
Cardmarket pricing still needs to be acquired. In fact the build already serves
Cardmarket price points (EUR→GBP) via pokemontcg.io/TCGdex with `price_cache`, margins,
and a nightly cron. The *official* Cardmarket API matters later for listing sync and
freshness — apply now (2–4 week approval), but launch doesn't block on it.

---

## Part 2 — Gap analysis: research requirements vs current build

The research assumes "the prototype works single-tenant". It undersells it — the shop-facing
product is **feature-complete for the Starter and Growth tiers today**, including things the
research lists as differentiators:

| Research requirement | Current build | Status |
|---|---|---|
| POS, server-canonical pricing, discounts | `lib/domain/sales.ts`, expectedTotal verification | ✅ |
| Buylist ("minutes not hours") | `buy_transactions`/`buy_items`, market-price offers | ✅ |
| Inventory + adjustments + CSV import/export | inc. `app/api/inventory/import` (onboarding SOP needs this) | ✅ |
| Store credit | append-only `credit_ledger` | ✅ |
| Customer management + purchase history | F3, PR #13 | ✅ |
| **UK VAT incl. margin scheme** (headline differentiator) | F2, PR #16 — `computeSaleTotals` margin/standard/none, stock book | ✅ |
| Cardmarket-referenced pricing + margins | `price_cache`, `primaryPriceSource='cardmarket'`, cron sync | ✅ (indirect source) |
| Multi-user staff w/ PINs + management UI | F1, PR #14; lockouts | ✅ |
| Reporting (margins, top cards, cash-up) | `lib/domain/reports.ts` | ✅ (F9 extras pending) |
| Want-list / customer wants | F4, PR #15 | ✅ |
| **Multi-tenancy** (registry, resolution, provisioning) | single-tenant: one `db` singleton, one env URL | ❌ **the build** |
| **Stripe Billing** (trials, tiers, dunning, portal) | none | ❌ |
| **Platform signup → auto-provisioned shop** | none (manual deploy per shop) | ❌ |
| **Platform admin dashboard** (tenants, billing, impersonate) | none | ❌ |
| In-app onboarding checklist | none | ❌ |
| Transactional email (welcome/trial/dunning) | none — also the unwired seam for F4 phase-2 notifications | ❌ |
| Health endpoint + uptime monitoring | no `/api/health` | ❌ |
| Sentry error monitoring | not wired (account is founder-side) | ❌ |
| Backup automation (per-tenant export) | Turso PITR only | ❌ |
| Rate limiting on public endpoints | auth lockouts only (per-shop login) | ❌ |
| Full-shop GDPR data export / tenant deletion | partial (inventory/sales CSV) | ⚠️ extend |
| Brand rename readiness | "pokedb" in cookie name, titles, package | ⚠️ prep |
| Plan/tier feature gating | none (no concept of plans) | ❌ |
| Pro tier: listing sync, public API | none — **deliberately deferred** (Month 4–6+, Year 2) | ⏸ |

**Conclusion**: nothing significant is missing from the *shop product*. Everything missing
is the **platform layer around it**. That's the entire build: turn one shop into N shops,
billed, provisioned, and operable by a 3-person team.

Two codebase facts make this much cheaper than the research's 4–6 week estimate assumes
blind:
1. **Every domain function already takes a `Db` handle** (`createSale(input, dbc: Db = db)`)
   — the tenancy refactor is edge-only: resolve the right `Db` per request and pass it.
   ~29 files import the singleton; the edits are mechanical.
2. **A tenant DB is exactly today's schema.** No shop table changes. Wizard-of-Oz beta
   databases *are already* valid tenant databases — "migrating" a beta shop into the
   platform means adding a registry row pointing at their existing Turso DB.

---

## Part 3 — Target architecture

### 3.1 Topology

```
                        ┌─────────────────────────────────────────┐
                        │  Vercel app (one deployment)            │
  www.<brand>.co.uk ───▶│  marketing/signup pages (later; Carrd   │
                        │  external at validation stage)          │
  <shop>.<brand>.co.uk ▶│  proxy.ts → tenant resolution → (app)   │──▶ tenant DB (Turso, EU/fra)
  admin.<brand>.co.uk ─▶│  platform admin (founders only)         │──▶ registry DB + Stripe API
                        │  /api/platform/* (signup, webhooks)     │
                        │  /api/cron/* (price sync, backups)      │
                        └─────────────────────────────────────────┘
   Stripe Billing ──webhooks──▶ /api/platform/stripe  ──▶ provision / suspend / plan change
   Resend ◀── platform emails (welcome, dunning) + shop emails (receipts, wants — later)
```

One Next.js deployment serves all tenants on wildcard subdomains. No per-shop deploys
after the Wizard-of-Oz phase (but that mode stays supported — see 3.8).

### 3.2 Databases

**Registry DB** (new, one, platform-owned — never touched by shop code):

```
tenants            id, slug (subdomain, unique), name, status, plan,
                   stripe_customer_id, stripe_subscription_id,
                   turso_db_name, region, setup_token, setup_completed_at,
                   entitlement_overrides (json — founding-shop deals, seat bumps),
                   created_at, updated_at
stripe_events      stripe_event_id (unique), type, processed_at        -- webhook idempotency
tenant_sync_state  tenant_id, last_price_sync_at, last_catalogue_sync_at, last_backup_at
platform_audit     id, actor, tenant_id, action, detail, created_at    -- impersonation etc.
```

`status`: `trialing → active → past_due → suspended → cancelled(→ export window → deleted)`,
plus `paused` (risk report's £9/month "keep data, no POS" retention plan — model it now,
build the price later).

**Tenant DBs** (one per shop): **exactly the current schema, unchanged** — cards,
price_cache, inventory, sales, buys, customers, credit_ledger, staff, settings, want_list…
Self-contained: every existing query/join stays within one SQLite file. Shop-level settings
stay in the tenant's `settings` table; *commercial* facts (plan, billing) live only in the
registry.

**Migrations**: Turso **database schemas** — a parent schema DB; tenant DBs are created as
children; drizzle-kit migrations run against the parent and propagate to all children.
This replaces the current "migrate the one live DB" workflow (and folds in the pending
0013/0014 rollout). Rule from the ops report stands: never migrate the parent without
testing against a copy of a real tenant DB first. *(Verify the current Turso API for
schema DBs at build time; if it has moved on, the fallback is an explicit loop —
`for tenant in registry: migrate(tenant)` — which the backup cron needs anyway.)*

### 3.3 Request flow (tenant resolution)

This Next version uses `proxy.ts` (not `middleware.ts` — the tech report predates that):

```
request → proxy.ts
  1. host = shop1.<brand>.co.uk  → slug "shop1"   (admin./www. route to their sections)
  2. registry lookup by slug (cached, ~60s TTL) → { tenantId, dbName, status }
  3. status gate: suspended/cancelled → lock screen; past_due → banner flag
  4. strip inbound x-tenant-* headers, set x-tenant-id / x-tenant-db (spoof-proof)
  5. existing auth redirect logic (unchanged)

route handler / server component
  const db = await getTenantDb()        // reads header, returns cached drizzle client
  session check: session.tenantId === resolved tenant, else 401  (defence in depth)
  domain fn(input, db)                  // domain layer unchanged
```

`lib/db/index.ts` becomes a factory: module-level `Map<tenantId, Db>` of libsql clients
(they're lightweight HTTP clients; caching is safe). Auth tokens: use a Turso **group
token** from env — per-DB tokens in the registry are avoidable complexity.

**`TENANCY_MODE=single` env escape hatch**: resolution short-circuits to
`TURSO_DATABASE_URL` exactly as today. This keeps `npm test` (`:memory:`), the Playwright
e2e, local dev, and Wizard-of-Oz deployments working untouched, and makes the refactor
landable incrementally.

### 3.4 Auth

- **Shop auth: unchanged.** Owner password + staff PINs live in the tenant DB;
  iron-session as-is. `SessionData` gains `tenantId`; cookies are host-only per subdomain
  (isolation for free). Cookie name changes from `pokedb-session` to a brand-neutral one.
- **Setup flow**: provisioning stores a one-time `setup_token`; the welcome email links to
  `/setup?token=…` where the owner sets the shop password + first admin PIN, then lands in
  the onboarding checklist.
- **Platform admin**: founders only, on the admin host — env-based credentials
  (`PLATFORM_ADMIN_PASSWORD_HASH`), separate cookie, `platform_admin` role. Impersonation
  ("open shop as owner") mints a tenant session and writes to `platform_audit`.

### 3.5 Billing (Stripe)

- Products: Starter £39 / Growth £79 / Pro £149 monthly (+20% UK VAT via Stripe Tax);
  annual "12-for-10" prices added ~Week 12 per the building report.
- 14-day trial **without card** (validation + ops reports are explicit); card collected at
  trial end via Stripe's hosted flows. Stripe **customer portal** for self-serve plan
  changes/cancellation — we build no billing UI.
- Webhooks (`/api/platform/stripe`, signature-verified, idempotent via `stripe_events`):
  - `checkout.session.completed` → provision tenant (3.6)
  - `customer.subscription.updated` → plan / status sync to registry
  - `invoice.payment_failed` → `past_due` + dunning email
  - `customer.subscription.deleted` → `suspended` → 30-day export window → deletion
- **Entitlements**: new dependency-free `lib/plan.ts` (client-importable, per the
  client-bundle boundary rule) mapping plan → limits/flags, e.g. staff seats
  (Starter 2 / Growth 5 / Pro unlimited), `listingSync` (Pro, future), `apiAccess`
  (Pro, future). Enforced in domain/API code; `entitlement_overrides` in the registry
  handles founding-shop deals. Tiny at launch — the point is the seam.

### 3.6 Provisioning (signup → live shop, automated)

```
signup form (rate-limited) → Stripe checkout/trial → webhook:
  1. turso.createDatabase(`shop-<slug>`, group: eu/fra, schema: parent)
  2. registry insert (status=trialing, setup_token)
  3. seed tenant settings row (defaults: GBP, vat scheme, margins)
  4. Resend welcome email → setup link + "5 things to do first" + Calendly link
owner: /setup → password + PIN → onboarding checklist
```

Onboarding checklist (first-login card, state in tenant `settings`): shop name/logo →
pricing margins → first 5 inventory items (or CSV import — **already built**) → test sale
→ staff PINs. Ops target: transacting inside 60 minutes.

**Catalogue seeding**: `import-catalogue.ts` (~20K cards) runs against the new tenant DB
as a provisioning step — as a queued job, not inline in the webhook (Vercel function
time limits; the report's "shop live in 60 min" allows it to finish in the background
while the owner does setup).

### 3.7 Price/catalogue sync at N tenants

Today's cron syncs one DB. Multi-tenant plan, in order of scale:

- **Launch (≤ ~50 shops)**: cron fans out — each invocation processes the next batch of
  tenants by `tenant_sync_state` cursor (staggered, resumable, inside function limits).
  External API budget is fine: a full sweep is ~100–200 requests/tenant/day against
  pokemontcg.io's 20K/day key.
- **Scale path (when API limits or cron duration bite)**: platform **master catalogue DB**
  — external APIs sync *once* into it, then an internal replication job upserts
  cards/prices into tenant DBs in batches. Tenant schema and all queries unchanged; only
  the sync *source* swaps. This also cuts per-tenant Scrydex/TCGdex image-host churn.
- **Never**: a shared live catalogue DB with app-level cross-DB joins — it would rewrite
  every inventory/POS query and forfeit SQLite join locality.
- Official Cardmarket API, once approved, slots in as a source inside `lib/prices/sync.ts`
  behind the existing `primaryPriceSource` setting. RapidAPI wrapper / CSV import are the
  researched fallbacks if it's denied (risk #4).

### 3.8 Wizard-of-Oz mode (Weeks 1–3, and the schedule-slip contingency)

Zero new code required for validation revenue: deploy the repo per shop with
`TENANCY_MODE=single` (a runbook + env template is worth an hour of writing). Because
tenant DBs are schema-identical, each beta shop's DB is later adopted by inserting a
registry row — no data migration. The risk report's contingency ("multi-tenancy takes 3×
longer → keep manually deploying, cap at 10") is therefore structurally supported.

### 3.9 Operational hardening (Week 8 checklist from the reports)

- `/api/health` — registry ping + one tenant ping → UptimeRobot (5-min checks, SMS on P1).
- Sentry SDK wiring, env-gated (founder creates the account — already on the user-side list).
- **Backup cron**: nightly loop exporting each tenant DB to object storage (Vercel Blob),
  cursor in `tenant_sync_state`; Turso PITR (30d on Scaler) is the primary restore, dumps
  are the belt-and-braces + tested-restore artefact (ops report: monthly restore drill).
- Rate limiting on platform-public endpoints (signup, auth, webhook) — fixed-window
  counters; shop-side login lockouts already exist.
- PostHog (product analytics) + Crisp (support chat) embeds in the app layout, env-gated.
- `lib/email.ts` (Resend): platform templates (welcome, trial day-4/day-12, dunning,
  churn) — and it's the provider seam `lib/domain/wants.ts` phase-2 notifications and
  F11 email receipts have been waiting for.

### 3.10 GDPR & data lifecycle (legal report → features)

- **Full-shop export**: one zip (CSV/JSON per table) from Settings, self-service — extends
  the existing inventory/sales exports. Required by the DPA, the churn/offboarding SOP,
  and the shutdown checklist; also answers the #1 trust objection in the interview script
  ("what would make you trust a new platform with your shop data?").
- **Tenant deletion**: cancelled + export window elapsed → delete Turso DB (the
  db-per-tenant payoff: auditable, total), delete registry row, retain Stripe invoices
  (legal/accounting).
- EU (Frankfurt) region on all tenant DBs; sub-processor list (Vercel, Turso, Stripe,
  Resend, Sentry, PostHog, Crisp) documented for the DPA. ToS/DPA/privacy are template
  documents on the marketing site — content, not code.

### 3.11 Rename readiness

The name decision + trademark is founder-side (Week 1 of the plan; ~£170 IPO Class 42).
Code prep is cheap and worth doing before any tenant exists: centralise brand into
`lib/brand.ts` (name, domain, support email — env-driven), rename the session cookie,
sweep user-visible "PokeDB" strings and email templates through it. Repo/package rename
happens once the name is chosen. UK-English copy audit (catalogue/colour) rides along.

---

## Part 4 — Build plan (maps to the research's Weeks 4–9)

Each phase is shippable and gated; shop-product code stays untouched until Phase 1's edge
refactor, which lands behind `TENANCY_MODE`.

**Phase 0 — now, pre-validation (≈1 day)** — DONE (2026-07-12)
Wizard-of-Oz runbook + env template; `lib/brand.ts` + cookie rename; `/api/health`.
*Unblocks the Week-1–3 validation sprint with zero platform code.*

**Phase 1 — tenancy core (≈1.5–2 weeks)** — DONE (2026-07-12)
Registry DB + schema; `getTenantDb()` factory replacing the singleton across ~29 files;
`proxy.ts` subdomain resolution + status gates + header injection; session `tenantId`;
convert migrations to the parent-schema model. **Exit test**: two tenants on one local
deployment, full e2e green on both, `npm test` still green in single mode.

Deviations from plan: guard test allowlists the health route (platform liveness exception); create-tenant checks the registry before touching the tenant DB and grew a --skip-migrations flag for adopting already-migrated DBs; sweepTcgplayerCatalogue takes dbc as its 3rd parameter (the plan's sample showed 2nd); cron fan-out is a simple sequential loop as planned, cursor staggering remains Phase 3.

**Phase 2 — billing + provisioning (≈1.5–2 weeks)**
Stripe products/checkout/portal/webhooks (idempotent); provisioning incl. catalogue seed
job; setup-token owner flow; Resend emails; onboarding checklist; `lib/plan.ts` gating.
**Exit test**: cold signup → trial → live shop processing a sale, card-less; payment-failed
→ dunning → suspend path exercised via Stripe test clocks.

**Phase 3 — platform ops (≈1 week)**
Admin dashboard (tenant list, billing status, last activity, impersonate w/ audit);
Sentry; backup cron + restore drill; rate limits; PostHog/Crisp; full-shop export;
sync-cron fan-out conversion. Adopt the beta shops via registry rows. **Exit**: launch
review checklist from the master plan (5+ shops, no P1s, billing clean).

**Phase 4 — post-launch, demand-driven**
The existing F5–F11 backlog (cash-up close, split tender, voids, reporting extras, receipt
email/sales search) reordered by paying-customer requests per the ops report; Pro-tier
listing sync + public API when Cardmarket API approval and 30+ shops justify them; master-
catalogue replication when tenant count demands it.

Total new-code estimate: **4–5 weeks** for one focused developer — consistent with the
tech report (5–6) minus the head start the `Db`-handle architecture and finished shop
features provide. The single biggest schedule risk is the same one the pre-mortem names:
tenancy edge cases (migrations, provisioning failures) — hence the escape hatch and the
Wizard-of-Oz cap as standing fallback.

## Part 5 — Explicitly not building (research-mandated scope control)

- Stripe Connect / payment facilitation — Year 2, after 30+ shops (and never direct FCA).
- Cardmarket/eBay listing sync — Pro tier, Month 4–6 at the earliest, post-API-approval.
- Freemium tier (review report: "never on this runway"), enterprise/multi-location, EU
  localisation, community pricing network (contingency only), a custom billing UI
  (Stripe portal), a new auth provider, shared-schema tenancy.

## Open questions for the founders

1. **Brand name** — blocks trademark, domain, cookie/UI sweep (Week 1 task; top
   candidates and the IPO/domain check process are in the marketing report).
2. Seat limits per tier (research only says "multi-user = Pro"; suggested 2/5/unlimited).
3. Wizard-of-Oz beta pricing: free-3-months (validation report) vs £149 managed-setup
   (risk report) — commercial call, no code impact.
4. Cardmarket commercial account + API application — founder action, start now (2–4 week
   lead time); the build doesn't block on it.
