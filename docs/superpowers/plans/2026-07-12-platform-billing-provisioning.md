# Platform Phase 2 — Stripe Billing + Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 of the SaaS spec (`docs/superpowers/specs/2026-07-11-saas-platform-architecture.md` §3.5–3.6, Part 4): a cold signup becomes a live, card-lessly trialing shop with no human in the loop — Stripe Checkout → webhook → Turso DB provisioned + migrated + catalogue-seeded → welcome email → owner sets password/PIN via setup token → onboarding checklist — plus webhook-driven billing lifecycle (plan sync, dunning, suspension), the Stripe customer portal as the only billing UI, and `lib/plan.ts` entitlement gating.

**Architecture:** All billing/provisioning code lives in `lib/platform/` (registry-side, never imported by shop domain code) plus a dependency-free `lib/plan.ts` shared with the UI. Stripe is the source of truth for subscription state; webhooks (`/api/platform/stripe`, signature-verified, idempotent via the existing `stripe_events` table) project it into the registry `tenants` row, which the proxy already reads per request. Provisioning is an idempotent function (`provisionTenant`) so Stripe's webhook retries resume rather than duplicate. The catalogue seed (~20K cards, minutes) runs as a separate self-invoked job endpoint, with the existing nightly sync cron as the safety net. Everything is inert in single-tenant mode: platform routes 404, entitlements default to unlimited, `npm test`/e2e/Wizard-of-Oz deployments are untouched.

**Tech Stack:** Next.js 16 App Router (route handlers, `after()`), `stripe` (new dependency — the only one; Resend and the Turso Platform API are called with plain `fetch`), Drizzle + `@libsql/client`, iron-session, zod v4, node test runner via tsx.

## Global Constraints

- **Money is integer pence (GBP)** — plan prices in `lib/plan.ts` are `pricePence` integers (3900/7900/14900); format to pounds only in components. Stripe amounts are configured in the dashboard, never in code.
- **Client components never value-import `lib/domain/*`, `lib/db`, or `lib/platform/*`.** `lib/plan.ts` must stay dependency-free and client-importable (the `lib/adjustment-reasons.ts` pattern). `components/platform/*`, `components/onboarding/*`, and the billing components talk to API routes only.
- **`TENANCY_MODE` unset = single-tenant**: every new platform route returns 404, no new env vars are required, `npm test` / `npm run test:e2e` / Wizard-of-Oz deploys behave exactly as today.
- **New/changed API routes use `guarded()` (`lib/api.ts`) and zod `parseBody()` (`lib/validation.ts`)** — except the Stripe webhook body, which must be read raw (`await req.text()`) for signature verification, and is authenticated by that signature instead.
- **No API route or server component may import the `db` singleton** (`tests/tenancy-guard.test.ts` enforces). Platform routes use `getPlatformDb()` / `getTenantDbFor()`; tenant routes use `await getTenantDb()`.
- **Schema changes in this plan: exactly two** — registry `tenants.email` (platform migration 0001) and tenant `settings.onboarding` (tenant migration 0016). Nothing else in either schema file changes.
- Tiers per spec + open-question answer: Starter £39 (2 staff seats) / Growth £79 (5) / Pro £149 (unlimited); 14-day card-less trial; `entitlement_overrides` JSON in the registry overrides per-tenant.
- Statuses stay within the existing enum: `trialing | active | past_due | paused | suspended | cancelled`. Card-less trial expiry maps to `paused` (Stripe pauses the subscription when no payment method exists at trial end).
- New env vars (all optional in single mode): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO`, `RESEND_API_KEY`, `EMAIL_FROM`, `TURSO_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`. Already existing: `PLATFORM_BASE_HOST`, `PLATFORM_DATABASE_URL`, `TURSO_GROUP_AUTH_TOKEN`, `CRON_SECRET`.
- UK English in all user-visible copy and emails.
- Run `npm test` from the repo root (it sets `TURSO_DATABASE_URL=:memory:` itself). Commit after every task (`feat:`/`refactor:`/`docs:` prefixes).
- **Deviation note (consistent with Phase 1):** provisioning creates a plain Turso DB and applies the migration journal directly (same as `scripts/create-tenant.ts`) rather than Turso parent-schema DBs (spec §3.2's "verify at build time" caveat — the explicit-loop fallback is what we already do).

---

### Task 1: Schema groundwork — registry `tenants.email` + tenant `settings.onboarding`

**Files:**
- Modify: `lib/platform/schema.ts:15` (add `email` column)
- Modify: `lib/db/schema.ts:127` (add `onboarding` column next to `ownerPasswordHash`)
- Create: `lib/platform/migrations/0001_tenant-email.sql` (generated)
- Create: `lib/db/migrations/0016_onboarding-state.sql` (generated)
- Create: `lib/db/schema-onboarding.test.ts`
- Modify: `lib/platform/schema.test.ts` (append one test)

**Interfaces:**
- Produces: `tenants.email: text | null` (owner's email — welcome/dunning emails, Stripe receipts belong to Stripe). `settings.onboarding: text | null` — JSON `{ dismissedAt?: string; done?: string[] }`; **null means "checklist disabled"** (pre-existing/adopted shops never see it; provisioning seeds `'{}'`).

- [ ] **Step 1: Add the columns**

In `lib/platform/schema.ts`, after `stripeSubscriptionId`:

```ts
  email: text('email'),                            // owner email (welcome, dunning)
```

In `lib/db/schema.ts` settings table, after `ownerPasswordHash`:

```ts
  // Onboarding checklist state (JSON: { dismissedAt?, done? }). Null = feature
  // off — only tenants provisioned by the platform get a value seeded.
  onboarding: text('onboarding'),
```

- [ ] **Step 2: Generate both migrations**

```bash
npx drizzle-kit generate --config drizzle-platform.config.ts --name tenant-email
npx drizzle-kit generate --name onboarding-state
```

Expected: `lib/platform/migrations/0001_tenant-email.sql` containing `ALTER TABLE \`tenants\` ADD \`email\` text;` and `lib/db/migrations/0016_onboarding-state.sql` containing `ALTER TABLE \`settings\` ADD \`onboarding\` text;`. (drizzle-kit `generate` works offline; both configs load `.env.local` via `@next/env`.)

- [ ] **Step 3: Write the round-trip tests**

Create `lib/db/schema-onboarding.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb } from './test-helpers'
import { settings } from './schema'

test('settings.onboarding column round-trips JSON and defaults to null', async () => {
  const db = await createTestDb()
  await db.insert(settings).values({ id: 1, shopName: 'Test Shop' })
  const [before] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(before.onboarding, null)
  await db.update(settings).set({ onboarding: '{"done":["settings"]}' }).where(eq(settings.id, 1))
  const [after] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(after.onboarding, '{"done":["settings"]}')
})
```

Append to `lib/platform/schema.test.ts`:

```ts
test('tenants.email round-trips', async () => {
  const pdb = await createTestPlatformDb()
  const [row] = await pdb.insert(tenants)
    .values({ slug: 'email-shop', name: 'Email Shop', dbUrl: 'file:x.db', email: 'owner@example.com' })
    .returning()
  assert.equal(row.email, 'owner@example.com')
})
```

(If `createTestPlatformDb`/`tenants` aren't already imported at the top of that file, add them: `import { createTestPlatformDb } from './test-helpers'` / `import { tenants } from './schema'`.)

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all pass, including both new tests (test DBs apply the full journal, so a broken migration fails here).

- [ ] **Step 5: Commit**

```bash
git add lib/platform/schema.ts lib/db/schema.ts lib/platform/migrations lib/db/migrations lib/db/schema-onboarding.test.ts lib/platform/schema.test.ts
git commit -m "feat: add tenants.email (registry) and settings.onboarding (tenant) columns"
```

> Rollout note: tenant migration 0016 rides the same pending rollout as 0015 (the live dev DB is applied manually by the founder — see the migration/deploy runbook note in AGENTS.md). The registry has no long-lived deployment yet; `create-tenant.ts` and `createTestPlatformDb` apply platform migrations themselves.

---

### Task 2: `lib/plan.ts` entitlements + `PLAN_LIMIT` error code

**Files:**
- Create: `lib/plan.ts`
- Create: `lib/plan.test.ts`
- Modify: `lib/domain/errors.ts` (add `PLAN_LIMIT`)

**Interfaces:**
- Produces: `type Plan = 'starter' | 'growth' | 'pro'`; `interface Entitlements { staffSeats: number | null; listingSync: boolean; apiAccess: boolean }`; `PLANS: Record<Plan, { label: string; pricePence: number; entitlements: Entitlements }>`; `PLAN_IDS: Plan[]`; `isPlan(x: unknown): x is Plan`; `entitlementsFor(plan: Plan, overridesJson?: string | null): Entitlements`. DomainError code `'PLAN_LIMIT'` → HTTP 403. Consumed by Tasks 6, 7, 9, 11 and client components.

- [ ] **Step 1: Write the failing test**

Create `lib/plan.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { PLANS, PLAN_IDS, isPlan, entitlementsFor } from './plan'

test('three plans with pence prices and seat limits', () => {
  assert.deepEqual(PLAN_IDS, ['starter', 'growth', 'pro'])
  assert.equal(PLANS.starter.pricePence, 3900)
  assert.equal(PLANS.growth.pricePence, 7900)
  assert.equal(PLANS.pro.pricePence, 14900)
  assert.equal(PLANS.starter.entitlements.staffSeats, 2)
  assert.equal(PLANS.growth.entitlements.staffSeats, 5)
  assert.equal(PLANS.pro.entitlements.staffSeats, null)
})

test('isPlan narrows', () => {
  assert.ok(isPlan('starter'))
  assert.ok(!isPlan('enterprise'))
  assert.ok(!isPlan(null))
})

test('entitlementsFor merges registry overrides field-by-field', () => {
  assert.deepEqual(entitlementsFor('starter'), { staffSeats: 2, listingSync: false, apiAccess: false })
  assert.deepEqual(entitlementsFor('starter', '{"staffSeats":10}'),
    { staffSeats: 10, listingSync: false, apiAccess: false })
  // Malformed overrides never break resolution — base plan wins.
  assert.deepEqual(entitlementsFor('growth', 'not json'), entitlementsFor('growth'))
  // Never mutate the shared PLANS object.
  entitlementsFor('pro').apiAccess = false
  assert.equal(PLANS.pro.entitlements.apiAccess, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A6 "plan.test"`
Expected: FAIL — `Cannot find module './plan'`

- [ ] **Step 3: Create `lib/plan.ts`**

```ts
// Plan → entitlement mapping (spec §3.5). Dependency-free and client-importable
// (the lib/adjustment-reasons.ts pattern): the UI shows plan facts, the server
// enforces them. Prices are integer pence, display-only — Stripe owns billing
// amounts via dashboard-configured prices.
export type Plan = 'starter' | 'growth' | 'pro'

export interface Entitlements {
  staffSeats: number | null // null = unlimited
  listingSync: boolean      // Pro, future (spec §3.5)
  apiAccess: boolean        // Pro, future
}

export const PLANS: Record<Plan, { label: string; pricePence: number; entitlements: Entitlements }> = {
  starter: { label: 'Starter', pricePence: 3900, entitlements: { staffSeats: 2, listingSync: false, apiAccess: false } },
  growth: { label: 'Growth', pricePence: 7900, entitlements: { staffSeats: 5, listingSync: false, apiAccess: false } },
  pro: { label: 'Pro', pricePence: 14900, entitlements: { staffSeats: null, listingSync: true, apiAccess: true } },
}

export const PLAN_IDS = Object.keys(PLANS) as Plan[]

export function isPlan(x: unknown): x is Plan {
  return typeof x === 'string' && x in PLANS
}

// Registry entitlement_overrides JSON wins field-by-field (founding-shop deals,
// seat bumps). Malformed JSON is ignored rather than breaking tenant resolution.
export function entitlementsFor(plan: Plan, overridesJson?: string | null): Entitlements {
  const base = { ...PLANS[plan].entitlements }
  if (!overridesJson) return base
  try {
    return { ...base, ...(JSON.parse(overridesJson) as Partial<Entitlements>) }
  } catch {
    return base
  }
}
```

- [ ] **Step 4: Add the error code**

In `lib/domain/errors.ts`, extend the union (line 1–5) with `'PLAN_LIMIT'`:

```ts
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'BUY_CAP_EXCEEDED'
  | 'MARGIN_NO_COST' | 'PLAN_LIMIT'
```

And in the `STATUS` map:

```ts
  PLAN_LIMIT: 403,
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/plan.ts lib/plan.test.ts lib/domain/errors.ts
git commit -m "feat: plan entitlements module + PLAN_LIMIT error code"
```

---

### Task 3: Email — `lib/email.ts` transport + platform templates

**Files:**
- Create: `lib/email.ts`
- Create: `lib/email.test.ts`
- Create: `lib/platform/emails.ts`
- Create: `lib/platform/emails.test.ts`

**Interfaces:**
- Produces: `interface EmailMessage { to: string; subject: string; text: string; html?: string }`; `interface SendResult { ok: boolean; skipped?: boolean; id?: string }`; `sendEmail(msg: EmailMessage, fetchImpl?: typeof fetch): Promise<SendResult>`. Templates (pure functions returning `EmailMessage`): `welcomeEmail({ to, shopName, setupUrl })`, `trialEndingEmail({ to, shopName, shopUrl })`, `paymentFailedEmail({ to, shopName, shopUrl })`, `suspendedEmail({ to, shopName })`. Consumed by Tasks 5 and 6. This is also the provider seam F4 phase-2 wants-notifications and F11 receipt emails have been waiting for.

- [ ] **Step 1: Write the failing tests**

Create `lib/email.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { sendEmail } from './email'

test('sendEmail is a logged no-op without RESEND_API_KEY', async () => {
  delete process.env.RESEND_API_KEY
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' })
  assert.deepEqual(result, { ok: false, skipped: true })
})

test('sendEmail posts to Resend with bearer auth', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.EMAIL_FROM = 'Shop <hello@example.com>'
  let captured: { url: string; init: RequestInit } | null = null
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init! }
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
  }) as typeof fetch
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' }, fakeFetch)
  assert.deepEqual(result, { ok: true, id: 'email_123' })
  assert.equal(captured!.url, 'https://api.resend.com/emails')
  const headers = captured!.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer re_test_key')
  const body = JSON.parse(String(captured!.init.body))
  assert.equal(body.from, 'Shop <hello@example.com>')
  assert.deepEqual(body.to, ['a@b.com'])
  delete process.env.RESEND_API_KEY
  delete process.env.EMAIL_FROM
})

test('sendEmail reports failure without throwing', async () => {
  process.env.RESEND_API_KEY = 're_test_key'
  const fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello' }, fakeFetch)
  assert.deepEqual(result, { ok: false })
  delete process.env.RESEND_API_KEY
})
```

Create `lib/platform/emails.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { welcomeEmail, trialEndingEmail, paymentFailedEmail, suspendedEmail } from './emails'

test('welcome email carries the setup link and shop name', () => {
  const msg = welcomeEmail({ to: 'o@shop.com', shopName: 'Brads Cards', setupUrl: 'https://brads.example.com/setup?token=abc' })
  assert.equal(msg.to, 'o@shop.com')
  assert.ok(msg.text.includes('https://brads.example.com/setup?token=abc'))
  assert.ok(msg.text.includes('Brads Cards'))
})

test('lifecycle emails link back to the shop', () => {
  for (const msg of [
    trialEndingEmail({ to: 'o@shop.com', shopName: 'Brads Cards', shopUrl: 'https://brads.example.com/settings' }),
    paymentFailedEmail({ to: 'o@shop.com', shopName: 'Brads Cards', shopUrl: 'https://brads.example.com/settings' }),
  ]) {
    assert.ok(msg.text.includes('https://brads.example.com/settings'))
    assert.ok(msg.subject.length > 0)
  }
  assert.ok(suspendedEmail({ to: 'o@shop.com', shopName: 'Brads Cards' }).text.includes('Brads Cards'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 -A4 "email"`
Expected: FAIL — `Cannot find module './email'` / `'./emails'`

- [ ] **Step 3: Create `lib/email.ts`**

```ts
import { BRAND } from '@/lib/brand'

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface SendResult {
  ok: boolean
  skipped?: boolean
  id?: string
}

// Resend via plain fetch — no SDK dependency. Without RESEND_API_KEY (dev,
// tests, single-tenant installs) sending is a logged no-op so no flow ever
// blocks on email. Failures are reported, not thrown: email is always the
// last, non-critical step of whatever triggered it.
export async function sendEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[email skipped] to=${msg.to} subject="${msg.subject}"\n${msg.text}`)
    return { ok: false, skipped: true }
  }
  const from = process.env.EMAIL_FROM ?? `${BRAND.name} <onboarding@resend.dev>`
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  })
  if (!res.ok) {
    console.error(`[email failed] status=${res.status} to=${msg.to} subject="${msg.subject}"`)
    return { ok: false }
  }
  const body = (await res.json()) as { id?: string }
  return { ok: true, id: body.id }
}
```

- [ ] **Step 4: Create `lib/platform/emails.ts`**

```ts
import { BRAND } from '@/lib/brand'
import type { EmailMessage } from '@/lib/email'

// Platform lifecycle emails (spec §3.5/3.6/3.9). Plain text at launch —
// deliverability beats design. All copy UK English.

export function welcomeEmail(i: { to: string; shopName: string; setupUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `${i.shopName} is ready — finish setting up ${BRAND.name}`,
    text: [
      `Welcome to ${BRAND.name}!`,
      '',
      `${i.shopName} is provisioned and your 14-day free trial has started — no card needed.`,
      '',
      'Finish setup (takes two minutes):',
      i.setupUrl,
      '',
      'Your first five things to do:',
      '1. Set your shop password and your admin PIN (link above)',
      '2. Check pricing margins and your VAT scheme in Settings',
      '3. Add your first cards, or import your stock as CSV',
      '4. Ring up a test sale',
      '5. Add PINs for your staff',
      '',
      `Card catalogue and market prices are loading in the background and will be ready shortly.`,
      '',
      `Questions? Just reply, or email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function trialEndingEmail(i: { to: string; shopName: string; shopUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `Your ${BRAND.name} trial ends in 3 days`,
    text: [
      `Your free trial for ${i.shopName} ends in 3 days.`,
      '',
      'To keep trading without interruption, add a payment method:',
      i.shopUrl,
      '',
      `(Settings → Billing → Manage billing.) If you do nothing, your shop will pause at the end of the trial — your data is kept safe and you can pick up where you left off.`,
      '',
      `Questions? Email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function paymentFailedEmail(i: { to: string; shopName: string; shopUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `Payment failed for ${i.shopName} — action needed`,
    text: [
      `We couldn't take payment for ${i.shopName}.`,
      '',
      `We'll retry automatically over the next few days, but to avoid interruption please update your card now:`,
      i.shopUrl,
      '',
      `(Settings → Billing → Manage billing.)`,
      '',
      `Need help? Email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function suspendedEmail(i: { to: string; shopName: string }): EmailMessage {
  return {
    to: i.to,
    subject: `${i.shopName} has been suspended`,
    text: [
      `The subscription for ${i.shopName} has ended, so the shop is now suspended.`,
      '',
      `Your data is kept safe for 30 days. To reactivate (or to export your data), email ${BRAND.supportEmail} — we'll sort it the same day.`,
    ].join('\n'),
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts lib/email.test.ts lib/platform/emails.ts lib/platform/emails.test.ts
git commit -m "feat: Resend email transport + platform lifecycle templates"
```

---

### Task 4: `lib/platform/turso.ts` — tenant database creation

**Files:**
- Create: `lib/platform/turso.ts`
- Create: `lib/platform/turso.test.ts`
- Modify: `.gitignore` (ignore local `tenant-dbs/`)

**Interfaces:**
- Produces: `createTenantDatabase(slug: string, fetchImpl?: typeof fetch): Promise<{ dbUrl: string; created: boolean }>` — names the DB `shop-<slug>` in `TURSO_GROUP` (default `default`); treats HTTP 409 (already exists — webhook retry) as success by looking the hostname up; without `TURSO_API_TOKEN` falls back to `file:./tenant-dbs/shop-<slug>.db` so the whole signup flow runs locally. Consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `lib/platform/turso.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { createTenantDatabase } from './turso'

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch
}

test('falls back to a local file DB without TURSO_API_TOKEN', async () => {
  delete process.env.TURSO_API_TOKEN
  const r = await createTenantDatabase('brads-cards')
  assert.deepEqual(r, { dbUrl: 'file:./tenant-dbs/shop-brads-cards.db', created: true })
})

test('creates via the Turso platform API', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  process.env.TURSO_GROUP = 'fra-group'
  let posted: { url: string; body: Record<string, unknown> } | null = null
  const r = await createTenantDatabase('brads-cards', fakeFetch((url, init) => {
    posted = { url, body: JSON.parse(String(init!.body)) }
    return new Response(JSON.stringify({ database: { Hostname: 'shop-brads-cards-my-org.turso.io' } }), { status: 200 })
  }))
  assert.deepEqual(r, { dbUrl: 'libsql://shop-brads-cards-my-org.turso.io', created: true })
  assert.equal(posted!.url, 'https://api.turso.tech/v1/organizations/my-org/databases')
  assert.deepEqual(posted!.body, { name: 'shop-brads-cards', group: 'fra-group' })
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG; delete process.env.TURSO_GROUP
})

test('409 (already exists) resolves the existing hostname', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  const r = await createTenantDatabase('brads-cards', fakeFetch((url, init) => {
    if (init?.method === 'POST') return new Response('conflict', { status: 409 })
    assert.ok(url.endsWith('/databases/shop-brads-cards'))
    return new Response(JSON.stringify({ database: { Hostname: 'shop-brads-cards-my-org.turso.io' } }), { status: 200 })
  }))
  assert.deepEqual(r, { dbUrl: 'libsql://shop-brads-cards-my-org.turso.io', created: false })
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG
})

test('other API failures throw', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  await assert.rejects(
    () => createTenantDatabase('brads-cards', fakeFetch(() => new Response('boom', { status: 500 }))),
    /Turso create failed: 500/,
  )
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 -A4 turso`
Expected: FAIL — `Cannot find module './turso'`

- [ ] **Step 3: Create `lib/platform/turso.ts`**

```ts
import { mkdirSync } from 'node:fs'

// Turso Platform API: create one database per tenant (spec §3.2/3.6) in the
// EU group. Dev/test fallback: without TURSO_API_TOKEN the "database" is a
// local file, matching scripts/create-tenant.ts, so signup → provision →
// setup runs end-to-end on a laptop with zero cloud credentials.

export interface CreatedDb {
  dbUrl: string
  created: boolean
}

export async function createTenantDatabase(slug: string, fetchImpl: typeof fetch = fetch): Promise<CreatedDb> {
  const token = process.env.TURSO_API_TOKEN
  const name = `shop-${slug}`
  if (!token) {
    mkdirSync('./tenant-dbs', { recursive: true })
    return { dbUrl: `file:./tenant-dbs/${name}.db`, created: true }
  }
  const org = process.env.TURSO_ORG
  if (!org) throw new Error('TURSO_ORG is not set')
  const group = process.env.TURSO_GROUP ?? 'default'
  const base = `https://api.turso.tech/v1/organizations/${org}/databases`
  const auth = { authorization: `Bearer ${token}` }

  const res = await fetchImpl(base, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name, group }),
  })
  if (res.status === 409) {
    // Already exists — a webhook retry after a partial provision. Resolve the
    // hostname and carry on; provisioning is idempotent from here.
    const lookup = await fetchImpl(`${base}/${name}`, { headers: auth })
    if (!lookup.ok) throw new Error(`Turso lookup failed: ${lookup.status}`)
    const { database } = (await lookup.json()) as { database: { Hostname: string } }
    return { dbUrl: `libsql://${database.Hostname}`, created: false }
  }
  if (!res.ok) throw new Error(`Turso create failed: ${res.status} ${await res.text()}`)
  const { database } = (await res.json()) as { database: { Hostname: string } }
  return { dbUrl: `libsql://${database.Hostname}`, created: true }
}
```

- [ ] **Step 4: Ignore local tenant DBs**

Append to `.gitignore` (skip any line already present):

```
tenant-dbs/
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: all pass. Delete the stray `./tenant-dbs` directory the first test created: `rm -rf tenant-dbs`.

- [ ] **Step 6: Commit**

```bash
git add lib/platform/turso.ts lib/platform/turso.test.ts .gitignore
git commit -m "feat: Turso platform API client for tenant DB creation"
```

---

### Task 5: `provisionTenant()` + catalogue seed job

**Files:**
- Create: `lib/db/migrate.ts` (move `applyMigrations` out of test-helpers — it now runs in production)
- Modify: `lib/db/test-helpers.ts` (re-export `applyMigrations` from the new module)
- Modify: `scripts/create-tenant.ts:14` (import from `../lib/db/migrate`)
- Create: `lib/platform/provision.ts`
- Create: `lib/platform/provision.test.ts`
- Modify: `lib/platform/tenants.ts` (add `tenantUrl()` helper + `TENANT_SLUG_RE`)
- Modify: `lib/platform/tenants.test.ts` (append `tenantUrl` tests)
- Create: `app/api/platform/jobs/seed-catalogue/route.ts`
- Modify: `next.config.ts` (bundle migration files for the provisioning routes)

**Interfaces:**
- Consumes: `createTenantDatabase` (Task 4), `sendEmail`/`welcomeEmail` (Task 3), `Plan` (Task 2), `settings.onboarding` (Task 1).
- Produces:
  - `applyMigrations(client: Client): Promise<void>` from `lib/db/migrate.ts` (unchanged behaviour, new home).
  - `TENANT_SLUG_RE: RegExp` and `tenantUrl(slug: string, baseHost: string, path?: string): string` from `lib/platform/tenants.ts`.
  - `provisionTenant(input: ProvisionInput, deps?: ProvisionDeps): Promise<ProvisionResult>` where `ProvisionInput = { slug: string; name: string; email: string; plan: Plan; stripeCustomerId: string | null; stripeSubscriptionId: string | null }` and `ProvisionResult = { tenantId: number; setupUrl: string; alreadyProvisioned: boolean }`. Idempotent by slug.
  - `POST /api/platform/jobs/seed-catalogue` `{ tenantId: number }`, `Authorization: Bearer <CRON_SECRET>` → runs the full catalogue sweep for one tenant. Consumed by Task 6's webhook.

- [ ] **Step 1: Move `applyMigrations` to a runtime module**

Create `lib/db/migrate.ts` (code moved verbatim from `lib/db/test-helpers.ts`):

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@libsql/client'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

// Apply every migration in journal order. Used by tests, the e2e global
// setup, scripts/create-tenant.ts — and, since Phase 2, by provisioning at
// runtime (a new tenant DB is migrated from empty on signup).
export async function applyMigrations(client: Client): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] }
  for (const { tag } of journal.entries) {
    const migration = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.execute(trimmed)
    }
  }
}
```

In `lib/db/test-helpers.ts`: delete the local `applyMigrations` definition and its now-unused `MIGRATIONS_DIR` const, and add at the top:

```ts
export { applyMigrations } from './migrate'
```

(Keep the `readFileSync`/`join` imports only if still used by the remaining code; drop them otherwise.) In `scripts/create-tenant.ts`, change the import:

```ts
import { applyMigrations } from '../lib/db/migrate'
```

Run: `npm test 2>&1 | tail -3` — Expected: all pass (pure move).

- [ ] **Step 2: Add `TENANT_SLUG_RE` + `tenantUrl` to `lib/platform/tenants.ts`**

Append:

```ts
// Slug rules shared by signup validation and scripts/create-tenant.ts.
export const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

// Absolute URL for a tenant subdomain. Local base hosts get http + the dev
// port so emailed links work straight from `npm run dev`.
export function tenantUrl(slug: string, baseHost: string, path = ''): string {
  const local = baseHost === 'localhost' || baseHost.endsWith('.localhost')
  return local
    ? `http://${slug}.${baseHost}:3000${path}`
    : `https://${slug}.${baseHost}${path}`
}
```

In `scripts/create-tenant.ts`, replace the inline regex test (line 36) with `TENANT_SLUG_RE.test(slug)` and add `TENANT_SLUG_RE` to the existing `../lib/platform/tenants` import.

Append to `lib/platform/tenants.test.ts`:

```ts
test('tenantUrl builds shop links for prod and local hosts', () => {
  assert.equal(tenantUrl('brads', 'example-brand.co.uk', '/setup?token=t'),
    'https://brads.example-brand.co.uk/setup?token=t')
  assert.equal(tenantUrl('brads', 'localhost', '/settings'), 'http://brads.localhost:3000/settings')
})
```

(Add `tenantUrl` to that file's import from `./tenants`.)

- [ ] **Step 3: Write the failing provisioning tests**

Create `lib/platform/provision.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import { provisionTenant } from './provision'
import { createTestPlatformDb } from './test-helpers'
import { tenants, tenantSyncState } from './schema'
import * as tenantSchema from '@/lib/db/schema'
import type { EmailMessage } from '@/lib/email'

function fixture() {
  const dbPath = join(tmpdir(), `prov-${randomBytes(6).toString('hex')}.db`)
  const sent: EmailMessage[] = []
  return {
    dbPath,
    sent,
    input: {
      slug: 'brads-cards', name: "Brad's Cards", email: 'brad@example.com',
      plan: 'growth' as const, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
    },
    deps: async () => ({
      pdb: await createTestPlatformDb(),
      createDb: async () => ({ dbUrl: `file:${dbPath}` }),
      send: async (msg: EmailMessage) => { sent.push(msg); return { ok: true } },
      baseHost: 'example-brand.co.uk',
    }),
  }
}

test('provisionTenant migrates, seeds, registers and emails', async () => {
  const f = fixture()
  const deps = await f.deps()
  const r = await provisionTenant(f.input, deps)
  assert.equal(r.alreadyProvisioned, false)
  assert.match(r.setupUrl, /^https:\/\/brads-cards\.example-brand\.co\.uk\/setup\?token=[0-9a-f]{48}$/)

  // Registry row
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.slug, 'brads-cards'))
  assert.equal(t.status, 'trialing')
  assert.equal(t.plan, 'growth')
  assert.equal(t.email, 'brad@example.com')
  assert.equal(t.stripeCustomerId, 'cus_1')
  assert.equal(t.dbUrl, `file:${f.dbPath}`)
  assert.ok(t.setupToken && r.setupUrl.includes(t.setupToken))
  const [sync] = await deps.pdb.select().from(tenantSyncState).where(eq(tenantSyncState.tenantId, t.id))
  assert.ok(sync)

  // Tenant DB migrated + settings seeded with onboarding enabled
  const tdb = drizzle(createClient({ url: `file:${f.dbPath}` }), { schema: tenantSchema })
  const [s] = await tdb.select().from(tenantSchema.settings)
  assert.equal(s.shopName, "Brad's Cards")
  assert.equal(s.onboarding, '{}')

  // Welcome email
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].to, 'brad@example.com')
  assert.ok(f.sent[0].text.includes(r.setupUrl))
})

test('provisionTenant is idempotent by slug (webhook retry)', async () => {
  const f = fixture()
  const deps = await f.deps()
  const first = await provisionTenant(f.input, deps)
  const second = await provisionTenant(f.input, deps)
  assert.equal(second.alreadyProvisioned, true)
  assert.equal(second.tenantId, first.tenantId)
  assert.equal(second.setupUrl, first.setupUrl)
  assert.equal(f.sent.length, 1) // no duplicate welcome email
  const rows = await deps.pdb.select().from(tenants)
  assert.equal(rows.length, 1)
})

test('provisionTenant resumes over a half-created tenant DB', async () => {
  const f = fixture()
  const deps = await f.deps()
  // Simulate a prior attempt that created + migrated the DB but died before
  // registering: migrate it once ourselves, then provision "again".
  const { applyMigrations } = await import('@/lib/db/migrate')
  const client = createClient({ url: `file:${f.dbPath}` })
  await applyMigrations(client)
  client.close()
  const r = await provisionTenant(f.input, deps)
  assert.equal(r.alreadyProvisioned, false) // registry row is the source of truth
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.slug, 'brads-cards'))
  assert.ok(t)
})
```

Run: `npm test 2>&1 | grep -B2 -A4 provision` — Expected: FAIL — `Cannot find module './provision'`

- [ ] **Step 4: Create `lib/platform/provision.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '@/lib/db/migrate'
import * as tenantSchema from '@/lib/db/schema'
import { sendEmail } from '@/lib/email'
import type { Plan } from '@/lib/plan'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, tenantSyncState, platformAudit } from './schema'
import { clearTenantCache, tenantUrl } from './tenants'
import { createTenantDatabase } from './turso'
import { welcomeEmail } from './emails'

// Signup → live shop (spec §3.6). Called from the Stripe webhook, so every
// step must be safe under retries: the registry row is the commit point —
// if it exists, provisioning already succeeded; anything before it (DB
// creation, migration, settings seed) tolerates partial prior state.

export interface ProvisionInput {
  slug: string
  name: string
  email: string
  plan: Plan
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}

export interface ProvisionResult {
  tenantId: number
  setupUrl: string
  alreadyProvisioned: boolean
}

export interface ProvisionDeps {
  pdb?: PlatformDb
  createDb?: (slug: string) => Promise<{ dbUrl: string }>
  connect?: (dbUrl: string) => Client
  send?: typeof sendEmail
  baseHost?: string
}

export async function provisionTenant(input: ProvisionInput, deps: ProvisionDeps = {}): Promise<ProvisionResult> {
  const pdb = deps.pdb ?? getPlatformDb()
  const createDb = deps.createDb ?? createTenantDatabase
  const connect = deps.connect ?? defaultConnect
  const send = deps.send ?? sendEmail
  const baseHost = deps.baseHost ?? process.env.PLATFORM_BASE_HOST
  if (!baseHost) throw new Error('PLATFORM_BASE_HOST is not set')

  const [existing] = await pdb.select().from(tenants).where(eq(tenants.slug, input.slug)).limit(1)
  if (existing) {
    return {
      tenantId: existing.id,
      setupUrl: tenantUrl(input.slug, baseHost, existing.setupToken ? `/setup?token=${existing.setupToken}` : '/login'),
      alreadyProvisioned: true,
    }
  }

  const { dbUrl } = await createDb(input.slug)
  const client = connect(dbUrl)
  try {
    if (!(await hasTenantSchema(client))) await applyMigrations(client)
    const tdb = drizzle(client, { schema: tenantSchema })
    const seeded = await tdb.select({ id: tenantSchema.settings.id }).from(tenantSchema.settings).limit(1)
    if (seeded.length === 0) {
      // onboarding: '{}' switches the checklist on — only platform-provisioned
      // shops get it (adopted Wizard-of-Oz DBs keep null).
      await tdb.insert(tenantSchema.settings).values({ id: 1, shopName: input.name, onboarding: '{}' })
    }
  } finally {
    client.close()
  }

  const setupToken = randomBytes(24).toString('hex')
  const now = Math.floor(Date.now() / 1000)
  const [row] = await pdb.insert(tenants).values({
    slug: input.slug,
    name: input.name,
    email: input.email,
    status: 'trialing',
    plan: input.plan,
    stripeCustomerId: input.stripeCustomerId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    tursoDbName: dbUrl.startsWith('libsql:') ? `shop-${input.slug}` : null,
    dbUrl,
    setupToken,
    updatedAt: now,
  }).returning()
  await pdb.insert(tenantSyncState).values({ tenantId: row.id }).onConflictDoNothing()
  await pdb.insert(platformAudit).values({ actor: 'stripe', tenantId: row.id, action: 'provision', detail: input.slug })
  clearTenantCache()

  const setupUrl = tenantUrl(input.slug, baseHost, `/setup?token=${setupToken}`)
  await send(welcomeEmail({ to: input.email, shopName: input.name, setupUrl }))
  return { tenantId: row.id, setupUrl, alreadyProvisioned: false }
}

function defaultConnect(dbUrl: string): Client {
  return createClient({
    url: dbUrl,
    authToken: dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined,
  })
}

async function hasTenantSchema(client: Client): Promise<boolean> {
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
  return r.rows.length > 0
}
```

Run: `npm test 2>&1 | grep -A3 provision` — Expected: all three provision tests PASS.

- [ ] **Step 5: Create the seed-catalogue job route**

Create `app/api/platform/jobs/seed-catalogue/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenants, tenantSyncState } from '@/lib/platform/schema'
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue } from '@/lib/prices/sync'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

// Full catalogue sweep takes minutes — run in its own invocation with the
// platform maximum, kicked by the provisioning webhook (spec §3.6). Safe to
// re-run: the sweep upserts, and the nightly sync-prices cron fully seeds any
// tenant this misses.
export const maxDuration = 300

const seedBody = z.object({ tenantId: z.number().int().positive() })

export const POST = guarded(async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { tenantId } = await parseBody(req, seedBody)
  const pdb = getPlatformDb()
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!t) return NextResponse.json({ error: 'Unknown tenant' }, { status: 404 })
  const db = getTenantDbFor(String(t.id), t.dbUrl)
  const result = await sweepTcgplayerCatalogue(await getSettings(db), {}, db)
  await pdb.update(tenantSyncState)
    .set({ lastCatalogueSyncAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenantSyncState.tenantId, t.id))
  return NextResponse.json(result)
})
```

- [ ] **Step 6: Bundle migration files for runtime use**

`applyMigrations` reads `lib/db/migrations/*.sql` from disk at request time; Vercel's file tracing can't see dynamic `readFileSync` paths, so include them explicitly. In `next.config.ts`, add to the config object:

```ts
  // provisionTenant() applies lib/db/migrations/*.sql at runtime (Stripe
  // webhook); static tracing can't see the dynamic readFileSync paths.
  outputFileTracingIncludes: {
    '/api/platform/stripe': ['./lib/db/migrations/**/*'],
  },
```

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/db/migrate.ts lib/db/test-helpers.ts scripts/create-tenant.ts lib/platform/tenants.ts lib/platform/tenants.test.ts lib/platform/provision.ts lib/platform/provision.test.ts app/api/platform/jobs next.config.ts
git commit -m "feat: idempotent tenant provisioning + catalogue seed job"
```

---

### Task 6: Stripe client, webhook handlers, webhook route

**Files:**
- Run: `npm install stripe`
- Create: `lib/platform/stripe.ts`
- Create: `lib/platform/stripe.test.ts`
- Create: `lib/platform/billing.ts`
- Create: `lib/platform/billing.test.ts`
- Create: `app/api/platform/stripe/route.ts`

**Interfaces:**
- Consumes: `provisionTenant`/`ProvisionInput` (Task 5), email templates (Task 3), `isPlan`/`Plan` (Task 2), `tenantUrl` (Task 5), existing `stripeEvents` table.
- Produces:
  - `getStripe(): Stripe`; `priceIdForPlan(plan: Plan): string`; `planForPriceId(priceId: string | null | undefined): Plan | null` (env `STRIPE_PRICE_STARTER/GROWTH/PRO`).
  - `mapSubscriptionStatus(s: string): string` — Stripe subscription status → tenant status.
  - `interface StripeEventLike { id: string; type: string; data: { object: Record<string, unknown> } }` — structural, so tests build plain objects.
  - `interface BillingDeps { pdb: PlatformDb; provision: (input: ProvisionInput) => Promise<unknown>; send: typeof sendEmail; baseHost: string }`
  - `handleStripeEvent(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }>` — idempotent via claim-first on `stripe_events`; the claim is released on error so Stripe's retry re-processes.
  - `POST /api/platform/stripe` — signature-verified webhook endpoint; kicks the seed job via `after()` on fresh provisions. Consumed by Task 7 (checkout sessions it creates land here).

- [ ] **Step 1: Install stripe**

```bash
npm install stripe
```

Expected: added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing stripe-client tests**

Create `lib/platform/stripe.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import Stripe from 'stripe'
import { priceIdForPlan, planForPriceId } from './stripe'

test('plan ↔ price id mapping from env', () => {
  process.env.STRIPE_PRICE_STARTER = 'price_st'
  process.env.STRIPE_PRICE_GROWTH = 'price_gr'
  process.env.STRIPE_PRICE_PRO = 'price_pro'
  assert.equal(priceIdForPlan('growth'), 'price_gr')
  assert.equal(planForPriceId('price_pro'), 'pro')
  assert.equal(planForPriceId('price_unknown'), null)
  assert.equal(planForPriceId(null), null)
})

test('priceIdForPlan throws when env is missing', () => {
  delete process.env.STRIPE_PRICE_STARTER
  assert.throws(() => priceIdForPlan('starter'), /STRIPE_PRICE_STARTER/)
})

// Round-trip Stripe's own signature scheme offline — proves the webhook route's
// constructEvent wiring can be satisfied by the CLI/test fixtures.
test('stripe signature verification round-trips', () => {
  const stripe = new Stripe('sk_test_dummy')
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'ping', data: { object: {} } })
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' })
  const event = stripe.webhooks.constructEvent(payload, header, 'whsec_test')
  assert.equal(event.id, 'evt_1')
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, 'whsec_wrong'))
})
```

Run: `npm test 2>&1 | grep -B2 -A4 "stripe.test"` — Expected: FAIL — `Cannot find module './stripe'`

- [ ] **Step 3: Create `lib/platform/stripe.ts`**

```ts
import Stripe from 'stripe'
import type { Plan } from '@/lib/plan'

// Lazy singleton: importing this module must never require Stripe env
// (single-tenant deployments have none).
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    _stripe = new Stripe(key)
  }
  return _stripe
}

const PRICE_ENV: Record<Plan, string> = {
  starter: 'STRIPE_PRICE_STARTER',
  growth: 'STRIPE_PRICE_GROWTH',
  pro: 'STRIPE_PRICE_PRO',
}

export function priceIdForPlan(plan: Plan): string {
  const id = process.env[PRICE_ENV[plan]]
  if (!id) throw new Error(`${PRICE_ENV[plan]} is not set`)
  return id
}

export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null
  for (const plan of Object.keys(PRICE_ENV) as Plan[]) {
    if (process.env[PRICE_ENV[plan]] === priceId) return plan
  }
  return null
}
```

Run: `npm test 2>&1 | grep -A3 "stripe.test"` — Expected: PASS.

- [ ] **Step 4: Write the failing billing-handler tests**

Create `lib/platform/billing.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { handleStripeEvent, mapSubscriptionStatus, type BillingDeps, type StripeEventLike } from './billing'
import { createTestPlatformDb } from './test-helpers'
import { tenants, stripeEvents } from './schema'
import type { ProvisionInput } from './provision'
import type { EmailMessage } from '@/lib/email'

process.env.STRIPE_PRICE_STARTER = 'price_st'
process.env.STRIPE_PRICE_GROWTH = 'price_gr'
process.env.STRIPE_PRICE_PRO = 'price_pro'

async function makeDeps() {
  const pdb = await createTestPlatformDb()
  const provisioned: ProvisionInput[] = []
  const sent: EmailMessage[] = []
  const deps: BillingDeps = {
    pdb,
    provision: async (input) => { provisioned.push(input); return { tenantId: 1 } },
    send: async (msg) => { sent.push(msg); return { ok: true } },
    baseHost: 'example-brand.co.uk',
  }
  return { pdb, deps, provisioned, sent }
}

function checkoutCompleted(overrides: Partial<Record<string, unknown>> = {}): StripeEventLike {
  return {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_1',
        subscription: 'sub_1',
        customer_details: { email: 'brad@example.com' },
        metadata: { tenant_slug: 'brads-cards', shop_name: "Brad's Cards", plan: 'growth' },
        ...overrides,
      },
    },
  }
}

async function seedTenant(pdb: BillingDeps['pdb']) {
  const [t] = await pdb.insert(tenants).values({
    slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:x.db', email: 'brad@example.com',
    status: 'trialing', plan: 'growth', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
  }).returning()
  return t
}

test('checkout.session.completed provisions from metadata', async () => {
  const { deps, provisioned } = await makeDeps()
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'provisioned')
  assert.deepEqual(provisioned, [{
    slug: 'brads-cards', name: "Brad's Cards", email: 'brad@example.com', plan: 'growth',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
  }])
})

test('duplicate event ids are claimed once', async () => {
  const { deps, provisioned } = await makeDeps()
  await handleStripeEvent(checkoutCompleted(), deps)
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'duplicate')
  assert.equal(provisioned.length, 1)
})

test('a failed handler releases the claim so retries re-process', async () => {
  const { pdb, deps } = await makeDeps()
  deps.provision = async () => { throw new Error('turso down') }
  await assert.rejects(() => handleStripeEvent(checkoutCompleted(), deps), /turso down/)
  const claims = await pdb.select().from(stripeEvents)
  assert.equal(claims.length, 0)
  deps.provision = async () => ({ tenantId: 1 })
  const r = await handleStripeEvent(checkoutCompleted(), deps)
  assert.equal(r.outcome, 'provisioned')
})

test('sessions without our metadata are ignored', async () => {
  const { deps, provisioned } = await makeDeps()
  const r = await handleStripeEvent(checkoutCompleted({ metadata: {} }), deps)
  assert.equal(r.outcome, 'ignored:not-signup')
  assert.equal(provisioned.length, 0)
})

test('subscription.updated syncs status and plan to the registry', async () => {
  const { pdb, deps } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_sub_1', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'price_pro' } }] } } },
  }, deps)
  assert.equal(r.outcome, 'status:active')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'active')
  assert.equal(t.plan, 'pro')
})

test('subscription.updated for an unknown subscription is ignored (event ordering)', async () => {
  const { deps } = await makeDeps()
  const r = await handleStripeEvent({
    id: 'evt_sub_2', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_nope', status: 'active' } },
  }, deps)
  assert.equal(r.outcome, 'ignored:unknown-subscription')
})

test('subscription.deleted suspends and emails the owner', async () => {
  const { pdb, deps, sent } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_del_1', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', status: 'canceled' } },
  }, deps)
  assert.equal(r.outcome, 'status:suspended')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'suspended')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].subject.includes('suspended'))
})

test('trial_will_end sends the trial-ending email', async () => {
  const { pdb, deps, sent } = await makeDeps()
  await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_trial_1', type: 'customer.subscription.trial_will_end',
    data: { object: { id: 'sub_1', status: 'trialing' } },
  }, deps)
  assert.equal(r.outcome, 'emailed:trial_will_end')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.includes('https://brads-cards.example-brand.co.uk/settings'))
})

test('invoice.payment_failed marks past_due and sends dunning', async () => {
  const { pdb, deps, sent } = await makeDeps()
  const seeded = await seedTenant(pdb)
  const r = await handleStripeEvent({
    id: 'evt_inv_1', type: 'invoice.payment_failed',
    data: { object: { customer: 'cus_1' } },
  }, deps)
  assert.equal(r.outcome, 'status:past_due')
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, seeded.id))
  assert.equal(t.status, 'past_due')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].subject.includes('Payment failed'))
})

test('mapSubscriptionStatus covers the lifecycle', () => {
  assert.equal(mapSubscriptionStatus('trialing'), 'trialing')
  assert.equal(mapSubscriptionStatus('active'), 'active')
  assert.equal(mapSubscriptionStatus('past_due'), 'past_due')
  assert.equal(mapSubscriptionStatus('paused'), 'paused')       // card-less trial expired
  assert.equal(mapSubscriptionStatus('incomplete'), 'trialing')
  assert.equal(mapSubscriptionStatus('canceled'), 'suspended')
  assert.equal(mapSubscriptionStatus('unpaid'), 'suspended')
  assert.equal(mapSubscriptionStatus('incomplete_expired'), 'suspended')
})
```

Run: `npm test 2>&1 | grep -B2 -A4 "billing"` — Expected: FAIL — `Cannot find module './billing'`

- [ ] **Step 5: Create `lib/platform/billing.ts`**

```ts
import { eq } from 'drizzle-orm'
import { sendEmail } from '@/lib/email'
import { isPlan } from '@/lib/plan'
import type { PlatformDb } from './db'
import { stripeEvents, tenants, platformAudit } from './schema'
import { clearTenantCache, tenantUrl } from './tenants'
import { planForPriceId } from './stripe'
import type { ProvisionInput } from './provision'
import { trialEndingEmail, paymentFailedEmail, suspendedEmail } from './emails'

// Webhook-driven tenant lifecycle (spec §3.5). Division of labour:
//  - status/plan sync: customer.subscription.updated/.deleted ONLY
//    (except payment_failed's immediate past_due, which Stripe also mirrors
//    via a subscription.updated moments later — same terminal state)
//  - lifecycle emails: trial_will_end, invoice.payment_failed, .deleted
//  - provisioning: checkout.session.completed
// Idempotency: claim the event id in stripe_events first; duplicates no-op;
// a failed handler releases the claim so Stripe's retry re-processes.

export interface StripeEventLike {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export interface BillingDeps {
  pdb: PlatformDb
  provision: (input: ProvisionInput) => Promise<unknown>
  send: typeof sendEmail
  baseHost: string
}

export function mapSubscriptionStatus(s: string): string {
  switch (s) {
    case 'trialing': return 'trialing'
    case 'active': return 'active'
    case 'past_due': return 'past_due'
    case 'paused': return 'paused'        // card-less trial ended without a card
    case 'incomplete': return 'trialing'  // first payment still settling — don't lock the shop
    default: return 'suspended'           // canceled | unpaid | incomplete_expired
  }
}

export async function handleStripeEvent(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const claimed = await deps.pdb.insert(stripeEvents)
    .values({ stripeEventId: event.id, type: event.type })
    .onConflictDoNothing()
    .returning()
  if (claimed.length === 0) return { outcome: 'duplicate' }

  try {
    switch (event.type) {
      case 'checkout.session.completed': return await onCheckoutCompleted(event, deps)
      case 'customer.subscription.updated': return await onSubscriptionChanged(event, deps, false)
      case 'customer.subscription.deleted': return await onSubscriptionChanged(event, deps, true)
      case 'customer.subscription.trial_will_end': return await onTrialWillEnd(event, deps)
      case 'invoice.payment_failed': return await onPaymentFailed(event, deps)
      default: return { outcome: `ignored:${event.type}` }
    }
  } catch (e) {
    await deps.pdb.delete(stripeEvents).where(eq(stripeEvents.stripeEventId, event.id))
    throw e
  }
}

interface CheckoutSessionLike {
  customer?: unknown
  subscription?: unknown
  metadata?: Record<string, string> | null
  customer_details?: { email?: string | null } | null
}

async function onCheckoutCompleted(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const s = event.data.object as CheckoutSessionLike
  const slug = s.metadata?.tenant_slug
  const name = s.metadata?.shop_name
  const plan = s.metadata?.plan
  const email = s.customer_details?.email
  if (!slug || !name || !email || !isPlan(plan)) return { outcome: 'ignored:not-signup' }
  await deps.provision({
    slug,
    name,
    email,
    plan,
    stripeCustomerId: typeof s.customer === 'string' ? s.customer : null,
    stripeSubscriptionId: typeof s.subscription === 'string' ? s.subscription : null,
  })
  return { outcome: 'provisioned' }
}

interface SubscriptionLike {
  id: string
  status: string
  items?: { data?: { price?: { id?: string } }[] }
}

async function onSubscriptionChanged(event: StripeEventLike, deps: BillingDeps, deleted: boolean): Promise<{ outcome: string }> {
  const sub = event.data.object as unknown as SubscriptionLike
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeSubscriptionId, sub.id)).limit(1)
  // Unknown subscription: subscription events can outrun checkout.session.completed
  // during signup — the post-provision subscription.updated will catch us up.
  if (!t) return { outcome: 'ignored:unknown-subscription' }
  const status = deleted ? 'suspended' : mapSubscriptionStatus(sub.status)
  const plan = planForPriceId(sub.items?.data?.[0]?.price?.id)
  await deps.pdb.update(tenants)
    .set({ status, ...(plan ? { plan } : {}), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenants.id, t.id))
  await deps.pdb.insert(platformAudit)
    .values({ actor: 'stripe', tenantId: t.id, action: `status:${status}`, detail: event.type })
  clearTenantCache()
  if (deleted && t.email) {
    await deps.send(suspendedEmail({ to: t.email, shopName: t.name }))
  }
  return { outcome: `status:${status}` }
}

async function onTrialWillEnd(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const sub = event.data.object as unknown as SubscriptionLike
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeSubscriptionId, sub.id)).limit(1)
  if (!t?.email) return { outcome: 'ignored:unknown-subscription' }
  await deps.send(trialEndingEmail({
    to: t.email,
    shopName: t.name,
    shopUrl: tenantUrl(t.slug, deps.baseHost, '/settings'),
  }))
  return { outcome: 'emailed:trial_will_end' }
}

interface InvoiceLike { customer?: unknown }

async function onPaymentFailed(event: StripeEventLike, deps: BillingDeps): Promise<{ outcome: string }> {
  const inv = event.data.object as InvoiceLike
  const customerId = typeof inv.customer === 'string' ? inv.customer : null
  if (!customerId) return { outcome: 'ignored:no-customer' }
  const [t] = await deps.pdb.select().from(tenants).where(eq(tenants.stripeCustomerId, customerId)).limit(1)
  if (!t) return { outcome: 'ignored:unknown-customer' }
  await deps.pdb.update(tenants)
    .set({ status: 'past_due', updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(tenants.id, t.id))
  await deps.pdb.insert(platformAudit)
    .values({ actor: 'stripe', tenantId: t.id, action: 'status:past_due', detail: event.type })
  clearTenantCache()
  if (t.email) {
    await deps.send(paymentFailedEmail({
      to: t.email,
      shopName: t.name,
      shopUrl: tenantUrl(t.slug, deps.baseHost, '/settings'),
    }))
  }
  return { outcome: 'status:past_due' }
}
```

Run: `npm test 2>&1 | grep -A3 billing` — Expected: all billing tests PASS.

- [ ] **Step 6: Create the webhook route**

Create `app/api/platform/stripe/route.ts`:

```ts
import { NextRequest, NextResponse, after } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import { getPlatformDb } from '@/lib/platform/db'
import { getStripe } from '@/lib/platform/stripe'
import { handleStripeEvent, type StripeEventLike } from '@/lib/platform/billing'
import { provisionTenant, type ProvisionInput } from '@/lib/platform/provision'

// Stripe webhook (spec §3.5): signature is the authentication; body must stay
// raw for constructEvent, so no parseBody here. Idempotency + retry semantics
// live in handleStripeEvent.

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = req.headers.get('stripe-signature')
  if (!secret || !sig) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const raw = await req.text()
  let event: StripeEventLike
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret) as unknown as StripeEventLike
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const origin = req.nextUrl.origin
  const result = await handleStripeEvent(event, {
    pdb: getPlatformDb(),
    send: sendEmail,
    baseHost: process.env.PLATFORM_BASE_HOST ?? '',
    provision: async (input: ProvisionInput) => {
      const r = await provisionTenant(input)
      if (!r.alreadyProvisioned) scheduleCatalogueSeed(origin, r.tenantId)
      return r
    },
  })
  return NextResponse.json(result)
})

// Kick the ~20K-card catalogue import in its own invocation once we've
// answered Stripe (spec §3.6: background, not inline). Best-effort — the
// 5s abort just detaches us; the job keeps running server-side, and the
// nightly sync-prices cron fully seeds any tenant this misses.
function scheduleCatalogueSeed(origin: string, tenantId: number) {
  after(async () => {
    try {
      await fetch(new URL('/api/platform/jobs/seed-catalogue', origin), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch { /* fire-and-forget */ }
  })
}
```

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass (the tenancy-guard test sees the new routes use `getPlatformDb`/`getTenantDbFor`, not the singleton).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/platform/stripe.ts lib/platform/stripe.test.ts lib/platform/billing.ts lib/platform/billing.test.ts app/api/platform/stripe
git commit -m "feat: Stripe webhook — idempotent billing lifecycle + provisioning trigger"
```

---

### Task 7: Signup — rate limiter, checkout creation, public pages

**Files:**
- Create: `lib/platform/rate-limit.ts`
- Create: `lib/platform/rate-limit.test.ts`
- Create: `lib/platform/signup.ts`
- Create: `lib/platform/signup.test.ts`
- Create: `app/api/platform/signup/route.ts`
- Create: `app/signup/page.tsx`
- Create: `app/signup/done/page.tsx`
- Create: `components/platform/SignupForm.tsx`
- Modify: `proxy.ts` (allow platform paths on non-tenant hosts + PUBLIC_PATHS)

**Interfaces:**
- Consumes: `getStripe`/`priceIdForPlan` (Task 6), `TENANT_SLUG_RE`/`RESERVED_SLUGS` (Task 5/Phase 1), `PLANS`/`isPlan` (Task 2).
- Produces:
  - `rateLimit(key: string, limit: number, windowMs: number, now?: number): boolean` (true = allowed) and `resetRateLimits()` — fixed-window, in-memory (per-instance is fine at launch; spec §3.9).
  - `validateSlug(slug: string): void` (throws `INVALID_INPUT`), `createSignupCheckout(input: { shopName: string; slug: string; email: string; plan: Plan; origin: string }, deps?: { pdb?: PlatformDb; createCheckout?: CheckoutCreator }): Promise<{ url: string }>`.
  - `POST /api/platform/signup` `{ shopName, slug, email, plan }` → `{ url }` (Stripe Checkout URL); `GET /signup` (plan picker + form), `GET /signup/done` (post-checkout landing).

- [ ] **Step 1: Write the failing rate-limit test**

Create `lib/platform/rate-limit.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { rateLimit, resetRateLimits } from './rate-limit'

beforeEach(() => resetRateLimits())

test('allows up to the limit inside a window, then blocks', () => {
  const t0 = 1_000_000
  assert.ok(rateLimit('ip:1', 3, 60_000, t0))
  assert.ok(rateLimit('ip:1', 3, 60_000, t0 + 1))
  assert.ok(rateLimit('ip:1', 3, 60_000, t0 + 2))
  assert.ok(!rateLimit('ip:1', 3, 60_000, t0 + 3))
})

test('window expiry resets the count; keys are independent', () => {
  const t0 = 1_000_000
  assert.ok(rateLimit('ip:2', 1, 60_000, t0))
  assert.ok(!rateLimit('ip:2', 1, 60_000, t0 + 59_999))
  assert.ok(rateLimit('ip:2', 1, 60_000, t0 + 60_000))
  assert.ok(rateLimit('ip:other', 1, 60_000, t0))
})
```

Run: `npm test 2>&1 | grep -B2 -A4 "rate-limit"` — Expected: FAIL — `Cannot find module './rate-limit'`

- [ ] **Step 2: Create `lib/platform/rate-limit.ts`**

```ts
// Fixed-window in-memory limiter (spec §3.9). Per-instance state is the right
// trade at launch: instances are reused under Fluid compute, and the goal is
// blunting abuse on public endpoints, not precise global quotas.
const buckets = new Map<string, { windowStart: number; count: number }>()

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key)
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 })
    return true
  }
  b.count += 1
  return b.count <= limit
}

export function resetRateLimits(): void {
  buckets.clear()
}
```

Run: `npm test 2>&1 | grep -A3 "rate-limit"` — Expected: PASS.

- [ ] **Step 3: Write the failing signup tests**

Create `lib/platform/signup.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { createSignupCheckout, validateSlug } from './signup'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { DomainError } from '@/lib/domain/errors'

process.env.STRIPE_PRICE_GROWTH = 'price_gr'

test('validateSlug rejects bad formats and reserved names', () => {
  for (const bad of ['ab', 'UPPER', 'has space', '-lead', 'trail-', 'www', 'admin']) {
    assert.throws(() => validateSlug(bad), DomainError, bad)
  }
  validateSlug('brads-cards') // no throw
})

test('createSignupCheckout rejects a taken slug before touching Stripe', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'brads-cards', name: 'Existing', dbUrl: 'file:x.db' })
  await assert.rejects(
    () => createSignupCheckout(
      { shopName: 'B', slug: 'brads-cards', email: 'a@b.com', plan: 'growth', origin: 'http://localhost:3000' },
      { pdb, createCheckout: async () => { throw new Error('should not be called') } },
    ),
    (e: unknown) => e instanceof DomainError && /taken/.test(e.message),
  )
})

test('createSignupCheckout builds the checkout request', async () => {
  const pdb = await createTestPlatformDb()
  let args: Record<string, unknown> | null = null
  const { url } = await createSignupCheckout(
    { shopName: "Brad's Cards", slug: 'brads-cards', email: 'a@b.com', plan: 'growth', origin: 'https://www.example-brand.co.uk' },
    { pdb, createCheckout: async (a) => { args = a as unknown as Record<string, unknown>; return { url: 'https://checkout.stripe.com/c/x' } } },
  )
  assert.equal(url, 'https://checkout.stripe.com/c/x')
  assert.deepEqual(args, {
    priceId: 'price_gr',
    email: 'a@b.com',
    metadata: { tenant_slug: 'brads-cards', shop_name: "Brad's Cards", plan: 'growth' },
    successUrl: 'https://www.example-brand.co.uk/signup/done',
    cancelUrl: 'https://www.example-brand.co.uk/signup',
  })
})
```

Run: `npm test 2>&1 | grep -B2 -A4 "signup"` — Expected: FAIL — `Cannot find module './signup'`

- [ ] **Step 4: Create `lib/platform/signup.ts`**

```ts
import { eq } from 'drizzle-orm'
import { DomainError } from '@/lib/domain/errors'
import type { Plan } from '@/lib/plan'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants as tenantsTable } from './schema'
import { RESERVED_SLUGS, TENANT_SLUG_RE } from './tenants'
import { getStripe, priceIdForPlan } from './stripe'

export interface SignupInput {
  shopName: string
  slug: string
  email: string
  plan: Plan
  origin: string
}

export interface CheckoutCreator {
  (args: {
    priceId: string
    email: string
    metadata: Record<string, string>
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string | null }>
}

export function validateSlug(slug: string): void {
  if (!TENANT_SLUG_RE.test(slug)) {
    throw new DomainError('INVALID_INPUT', 'Subdomain must be 3–40 characters: lowercase letters, digits and hyphens')
  }
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    throw new DomainError('INVALID_INPUT', 'That subdomain is reserved')
  }
}

// Signup step 1 (spec §3.6): validate, check availability, hand off to Stripe
// Checkout. The tenant is created by the checkout.session.completed webhook —
// nothing is written here, so an abandoned checkout leaves no residue. (Two
// simultaneous signups for one slug can both reach Checkout; the second one's
// webhook finds the slug taken and fails loudly for manual follow-up — an
// acceptable race at launch volume.)
export async function createSignupCheckout(
  input: SignupInput,
  deps: { pdb?: PlatformDb; createCheckout?: CheckoutCreator } = {},
): Promise<{ url: string }> {
  const pdb = deps.pdb ?? getPlatformDb()
  validateSlug(input.slug)
  const [taken] = await pdb.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(eq(tenantsTable.slug, input.slug)).limit(1)
  if (taken) throw new DomainError('INVALID_INPUT', 'That subdomain is already taken')

  const createCheckout = deps.createCheckout ?? stripeCheckout
  const { url } = await createCheckout({
    priceId: priceIdForPlan(input.plan),
    email: input.email,
    metadata: { tenant_slug: input.slug, shop_name: input.shopName, plan: input.plan },
    successUrl: `${input.origin}/signup/done`,
    cancelUrl: `${input.origin}/signup`,
  })
  if (!url) throw new Error('Stripe returned no checkout URL')
  return { url }
}

const stripeCheckout: CheckoutCreator = async (args) => {
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    // 14-day card-less trial (spec §3.5): nothing is due today so Checkout
    // shows no card fields; if no card exists at trial end Stripe pauses the
    // subscription (→ tenant status 'paused'), and adding a card via the
    // customer portal resumes it.
    payment_method_collection: 'if_required',
    subscription_data: {
      trial_period_days: 14,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
      metadata: args.metadata,
    },
    customer_email: args.email,
    metadata: args.metadata,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })
  return { url: session.url }
}
```

Run: `npm test 2>&1 | grep -A3 signup` — Expected: PASS.

- [ ] **Step 5: Create the signup API route**

Create `app/api/platform/signup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { createSignupCheckout } from '@/lib/platform/signup'

const signupBody = z.object({
  shopName: z.string().trim().min(2).max(60),
  slug: z.string().trim().toLowerCase().max(40),
  email: z.email().max(200),
  plan: z.enum(['starter', 'growth', 'pro']),
})

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`signup:${ip}`, 5, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many signup attempts — please try again in a few minutes')
  }
  const input = await parseBody(req, signupBody)
  const { url } = await createSignupCheckout({ ...input, origin: req.nextUrl.origin })
  return NextResponse.json({ url })
})
```

- [ ] **Step 6: Create the signup pages**

Create `app/signup/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'
import { SignupForm } from '@/components/platform/SignupForm'

export const metadata = { title: `Start your free trial` }

export default function SignupPage() {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Start your {BRAND.name} trial</h1>
          <p className="text-muted-foreground">14 days free. No card needed. Cancel any time.</p>
        </div>
        <SignupForm />
      </div>
    </main>
  )
}
```

Create `app/signup/done/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'

export const metadata = { title: 'Check your email' }

export default function SignupDonePage() {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-2xl font-semibold">You&apos;re in — check your email</h1>
        <p className="text-muted-foreground">
          We&apos;re setting up your shop now (it takes about a minute). Your welcome email
          contains the link to set your password and get started.
        </p>
        <p className="text-muted-foreground text-sm">
          Nothing arrived after a few minutes? Check spam, or email {BRAND.supportEmail}.
        </p>
      </div>
    </main>
  )
}
```

Create `components/platform/SignupForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { PLANS, PLAN_IDS, type Plan } from '@/lib/plan'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function suggestSlug(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function SignupForm() {
  const [shopName, setShopName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState<Plan>('growth')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/platform/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopName, slug, email, plan }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong')
      window.location.href = body.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {PLAN_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setPlan(id)}
            aria-pressed={plan === id}
            className={`rounded-lg border p-3 text-left ${plan === id ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
          >
            <div className="font-medium">{PLANS[id].label}</div>
            <div className="text-sm text-muted-foreground">£{PLANS[id].pricePence / 100}/month</div>
            <div className="text-xs text-muted-foreground">
              {PLANS[id].entitlements.staffSeats === null ? 'Unlimited staff' : `${PLANS[id].entitlements.staffSeats} staff seats`}
            </div>
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="shopName">Shop name</Label>
        <Input id="shopName" value={shopName} required minLength={2} maxLength={60}
          onChange={(e) => { setShopName(e.target.value); if (!slugEdited) setSlug(suggestSlug(e.target.value)) }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Your shop address</Label>
        <div className="flex items-center gap-1">
          <Input id="slug" value={slug} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
            onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()) }} />
          <span className="text-sm text-muted-foreground whitespace-nowrap">.{process.env.NEXT_PUBLIC_BRAND_BASE_HOST || 'yourshop.example'}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Your email</Label>
        <Input id="email" type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Redirecting…' : 'Start free trial'}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        You&apos;ll confirm your details with our payment provider — no card is taken for the trial.
      </p>
    </form>
  )
}
```

(`NEXT_PUBLIC_BRAND_BASE_HOST` is cosmetic — the suffix shown next to the slug field; add it to the env docs in Task 12.)

- [ ] **Step 7: Open the platform paths in `proxy.ts`**

Two edits. Replace the `PUBLIC_PATHS` line:

```ts
const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/cron/', '/api/health', '/suspended', '/signup', '/api/platform/']
```

And in the `not-tenant` branch, allow the platform surface (replace the `if (pathname.startsWith('/api/health'))` line):

```ts
    if (decision.kind === 'not-tenant') {
      // Apex/www/admin: marketing site is external; admin arrives in Phase 3.
      // The platform surface (signup, Stripe webhook, health) lives here.
      const platformPaths = ['/signup', '/api/platform/', '/api/health']
      if (platformPaths.some(p => pathname.startsWith(p))) {
        return NextResponse.next({ request: { headers: requestHeaders } })
      }
      return new NextResponse('Not found', { status: 404 })
    }
```

- [ ] **Step 8: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add lib/platform/rate-limit.ts lib/platform/rate-limit.test.ts lib/platform/signup.ts lib/platform/signup.test.ts app/api/platform/signup app/signup components/platform proxy.ts
git commit -m "feat: public signup flow — rate-limited checkout creation + plan picker"
```

---

### Task 8: Setup-token owner flow (`/setup`)

**Files:**
- Create: `lib/platform/setup.ts`
- Create: `lib/platform/setup.test.ts`
- Create: `app/api/setup/route.ts`
- Create: `app/setup/page.tsx`
- Create: `components/platform/SetupForm.tsx`
- Modify: `proxy.ts` (PUBLIC_PATHS: `/setup`, `/api/setup`)

**Interfaces:**
- Consumes: `setOwnerPasswordHash(hash, dbc)` + `createStaff({ name, pin, role }, dbc)` from `lib/domain/staff.ts` (Phase 1), registry `tenants.setupToken/setupCompletedAt`.
- Produces: `completeSetup(input: { tenantId: number; token: string; password: string; staffName: string; pin: string }, tenantDb: Db, pdb?: PlatformDb): Promise<{ staffId: number; staffName: string }>` — single-use, constant-time token check; `POST /api/setup` (mints a full owner+admin session); `GET /setup?token=…` page on the tenant subdomain.

- [ ] **Step 1: Write the failing tests**

Create `lib/platform/setup.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { completeSetup } from './setup'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { createTestDb } from '@/lib/db/test-helpers'
import { staff } from '@/lib/db/schema'
import { getOwnerPasswordHash } from '@/lib/domain/staff'
import { DomainError } from '@/lib/domain/errors'

async function fixture() {
  const pdb = await createTestPlatformDb()
  const tenantDb = await createTestDb()
  const [t] = await pdb.insert(tenants).values({
    slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:ignored.db',
    setupToken: 'a'.repeat(48),
  }).returning()
  return { pdb, tenantDb, tenant: t }
}

test('completeSetup sets the owner password, creates the admin, and burns the token', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  const r = await completeSetup(
    { tenantId: tenant.id, token: 'a'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' },
    tenantDb, pdb,
  )
  const hash = await getOwnerPasswordHash(tenantDb)
  assert.ok(hash && await bcrypt.compare('hunter2hunter2', hash))
  const [admin] = await tenantDb.select().from(staff).where(eq(staff.id, r.staffId))
  assert.equal(admin.role, 'admin')
  assert.equal(admin.name, 'Brad')
  const [after] = await pdb.select().from(tenants).where(eq(tenants.id, tenant.id))
  assert.equal(after.setupToken, null)
  assert.ok(after.setupCompletedAt)
})

test('a wrong or reused token is rejected', async () => {
  const { pdb, tenantDb, tenant } = await fixture()
  const input = { tenantId: tenant.id, token: 'b'.repeat(48), password: 'hunter2hunter2', staffName: 'Brad', pin: '4242' }
  await assert.rejects(() => completeSetup(input, tenantDb, pdb), DomainError)
  // Right token succeeds once…
  await completeSetup({ ...input, token: 'a'.repeat(48) }, tenantDb, pdb)
  // …and is dead afterwards.
  await assert.rejects(() => completeSetup({ ...input, token: 'a'.repeat(48) }, tenantDb, pdb), DomainError)
})
```

Run: `npm test 2>&1 | grep -B2 -A4 "setup"` — Expected: FAIL — `Cannot find module './setup'`

- [ ] **Step 2: Create `lib/platform/setup.ts`**

```ts
import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { DomainError } from '@/lib/domain/errors'
import type { Db } from '@/lib/db'
import { setOwnerPasswordHash, createStaff } from '@/lib/domain/staff'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, platformAudit } from './schema'

// The welcome email's one-time setup link (spec §3.4): the owner sets the
// shop password and their admin PIN in one step, then lands in the app.

export interface SetupInput {
  tenantId: number
  token: string
  password: string
  staffName: string
  pin: string
}

export async function completeSetup(
  input: SetupInput,
  tenantDb: Db,
  pdb: PlatformDb = getPlatformDb(),
): Promise<{ staffId: number; staffName: string }> {
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1)
  if (!t || !t.setupToken || t.setupCompletedAt) {
    throw new DomainError('FORBIDDEN', 'This setup link has already been used — log in instead')
  }
  if (!tokensMatch(input.token, t.setupToken)) {
    throw new DomainError('FORBIDDEN', 'This setup link is not valid')
  }
  await setOwnerPasswordHash(await bcrypt.hash(input.password, 10), tenantDb)
  const member = await createStaff({ name: input.staffName, pin: input.pin, role: 'admin' }, tenantDb)
  const now = Math.floor(Date.now() / 1000)
  await pdb.update(tenants)
    .set({ setupToken: null, setupCompletedAt: now, updatedAt: now })
    .where(eq(tenants.id, t.id))
  await pdb.insert(platformAudit).values({ actor: 'system', tenantId: t.id, action: 'setup_completed' })
  return { staffId: member.id, staffName: member.name }
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
```

Run: `npm test 2>&1 | grep -A3 "setup"` — Expected: PASS.

- [ ] **Step 3: Create the API route**

Create `app/api/setup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getTenantDb, isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { completeSetup } from '@/lib/platform/setup'

const setupBody = z.object({
  token: z.string().min(20),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  staffName: z.string().trim().min(1, 'Your name is required'),
  pin: z.string().regex(/^\d{4}$/, '4-digit PIN required'),
})

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenantId = await currentTenantId()
  if (!tenantId) throw new DomainError('UNAUTHORIZED', 'No tenant context')
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`setup:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts — please try again shortly')
  }
  const input = await parseBody(req, setupBody)
  const db = await getTenantDb()
  const result = await completeSetup({ tenantId: Number(tenantId), ...input }, db)

  // The owner just proved control via the emailed token: mint the full
  // owner + admin session so they land straight in the app.
  const session = await getSession(tenantId)
  session.isOwnerLoggedIn = true
  session.tenantId = tenantId
  session.staffId = result.staffId
  session.staffRole = 'admin'
  session.staffName = result.staffName
  await session.save()
  return NextResponse.json({ ok: true })
})
```

- [ ] **Step 4: Create the page and form**

Create `app/setup/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'
import { SetupForm } from '@/components/platform/SetupForm'

export const metadata = { title: 'Set up your shop' }

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  const { token } = await searchParams
  if (!token) notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Welcome to {BRAND.name}</h1>
          <p className="text-muted-foreground">Set your shop password and your PIN — then you&apos;re in.</p>
        </div>
        <SetupForm token={token} />
      </div>
    </main>
  )
}
```

Create `components/platform/SetupForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function SetupForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [staffName, setStaffName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Passwords do not match'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, staffName, pin }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong')
      window.location.href = '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">Shop password</Label>
        <Input id="password" type="password" value={password} required minLength={8}
          onChange={(e) => setPassword(e.target.value)} />
        <p className="text-xs text-muted-foreground">Unlocks the till each morning. At least 8 characters.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" type="password" value={confirm} required onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="staffName">Your name</Label>
        <Input id="staffName" value={staffName} required onChange={(e) => setStaffName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pin">Your admin PIN (4 digits)</Label>
        <Input id="pin" inputMode="numeric" pattern="\d{4}" maxLength={4} value={pin} required
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <p className="text-xs text-muted-foreground">Staff use PINs to switch user at the till.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Setting up…' : 'Finish setup'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 5: Open the paths in `proxy.ts`**

Extend `PUBLIC_PATHS` (from Task 7's value) with the two setup paths:

```ts
const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/cron/', '/api/health', '/suspended', '/signup', '/api/platform/', '/setup', '/api/setup']
```

- [ ] **Step 6: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/platform/setup.ts lib/platform/setup.test.ts app/api/setup app/setup components/platform/SetupForm.tsx proxy.ts
git commit -m "feat: one-time setup-token flow — owner password + admin PIN + auto-login"
```

---

### Task 9: Entitlement headers + staff seat gating

**Files:**
- Modify: `lib/platform/routing.ts` (inject `x-tenant-plan` / `x-tenant-entitlements`)
- Modify: `lib/platform/routing.test.ts` (cover the new headers)
- Modify: `proxy.ts:14` (strip the two new inbound headers)
- Create: `lib/entitlements.ts`
- Modify: `lib/domain/staff.ts` (add `assertStaffSeatAvailable`)
- Modify: `lib/domain/staff.test.ts` (seat-limit cases)
- Modify: `app/api/staff/route.ts` (gate POST)
- Modify: `app/api/staff/[id]/route.ts` (gate reactivation)

**Interfaces:**
- Consumes: `entitlementsFor`/`isPlan`/`Entitlements` (Task 2), `tenants.plan`/`entitlementOverrides` (Phase 1 schema).
- Produces: `decideTenantRouting` now also injects `x-tenant-plan` and `x-tenant-entitlements` (merged JSON — the proxy is the only writer, so readers can trust it); `getEntitlements(): Promise<Entitlements>` from `lib/entitlements.ts` (single mode → pro/unlimited); `assertStaffSeatAvailable(ent: Entitlements, dbc?: Db): Promise<void>` (throws `PLAN_LIMIT`). Consumed by Task 11's UI (upgrade nudge via 403 code).

- [ ] **Step 1: Extend the routing tests (failing first)**

In `lib/platform/routing.test.ts`, the fixture helper (line 5) and the `serve` test's full-object `deepEqual` (lines 21–29) both break when the type widens and two headers are added. Replace them:

```ts
const tenant = (status: string) => ({
  id: 7, dbUrl: 'file:/tmp/t.db', status, plan: 'starter', entitlementOverrides: null,
})
```

```ts
test('live tenants get trusted headers', () => {
  for (const s of ['trialing', 'active', 'past_due']) {
    const d = decideTenantRouting({ slug: 'x', tenant: tenant(s) })
    assert.equal(d.kind, 'serve')
    if (d.kind !== 'serve') return
    assert.equal(d.headers['x-tenant-id'], '7')
    assert.equal(d.headers['x-tenant-db-url'], 'file:/tmp/t.db')
    assert.equal(d.headers['x-tenant-status'], s)
    assert.equal(d.headers['x-tenant-plan'], 'starter')
    assert.deepEqual(JSON.parse(d.headers['x-tenant-entitlements']),
      { staffSeats: 2, listingSync: false, apiAccess: false })
  }
})
```

And append:

```ts
test('serve injects plan and merged entitlements headers', () => {
  const d = decideTenantRouting({
    slug: 'brads',
    tenant: { id: 7, dbUrl: 'file:x.db', status: 'active', plan: 'starter', entitlementOverrides: '{"staffSeats":10}' },
  })
  assert.equal(d.kind, 'serve')
  if (d.kind !== 'serve') return
  assert.equal(d.headers['x-tenant-plan'], 'starter')
  assert.deepEqual(JSON.parse(d.headers['x-tenant-entitlements']),
    { staffSeats: 10, listingSync: false, apiAccess: false })
})

test('an unrecognised plan value falls back to growth entitlements', () => {
  const d = decideTenantRouting({
    slug: 'brads',
    tenant: { id: 7, dbUrl: 'file:x.db', status: 'active', plan: 'legacy-weird', entitlementOverrides: null },
  })
  if (d.kind !== 'serve') assert.fail('expected serve')
  assert.equal(d.headers['x-tenant-plan'], 'growth')
})
```

Run: `npm test 2>&1 | grep -B2 -A4 routing` — Expected: FAIL (type error / missing headers).

- [ ] **Step 2: Update `lib/platform/routing.ts`**

```ts
import type { Tenant } from './schema'
import { entitlementsFor, isPlan, type Plan } from '@/lib/plan'

const BLOCKED_STATUSES = new Set(['suspended', 'cancelled', 'paused'])

export type TenantRouting =
  | { kind: 'not-tenant' }
  | { kind: 'unknown' }
  | { kind: 'blocked' }
  | { kind: 'serve'; headers: Record<string, string> }

export function decideTenantRouting(input: {
  slug: string | null
  tenant: Pick<Tenant, 'id' | 'dbUrl' | 'status' | 'plan' | 'entitlementOverrides'> | null
}): TenantRouting {
  if (input.slug === null) return { kind: 'not-tenant' }
  if (!input.tenant) return { kind: 'unknown' }
  if (BLOCKED_STATUSES.has(input.tenant.status)) return { kind: 'blocked' }
  const plan: Plan = isPlan(input.tenant.plan) ? input.tenant.plan : 'growth'
  return {
    kind: 'serve',
    headers: {
      'x-tenant-id': String(input.tenant.id),
      'x-tenant-db-url': input.tenant.dbUrl,
      'x-tenant-status': input.tenant.status,
      'x-tenant-plan': plan,
      // Merged here, once, so downstream readers never re-implement override
      // logic. The proxy strips inbound copies — this is the only writer.
      'x-tenant-entitlements': JSON.stringify(entitlementsFor(plan, input.tenant.entitlementOverrides)),
    },
  }
}
```

- [ ] **Step 3: Strip the new headers in `proxy.ts`**

Update the strip loop (line 14):

```ts
  for (const h of ['x-tenant-id', 'x-tenant-db-url', 'x-tenant-status', 'x-tenant-plan', 'x-tenant-entitlements']) requestHeaders.delete(h)
```

- [ ] **Step 4: Create `lib/entitlements.ts`**

```ts
import { entitlementsFor, isPlan, type Entitlements } from '@/lib/plan'

// Server-side view of the current request's entitlements, from the
// proxy-injected headers. Single-tenant installs are unmanaged
// (Wizard-of-Oz / dev / tests) — nothing is gated, i.e. pro.
export async function getEntitlements(): Promise<Entitlements> {
  if (process.env.TENANCY_MODE !== 'multi') return entitlementsFor('pro')
  const { headers } = await import('next/headers')
  const h = await headers()
  const raw = h.get('x-tenant-entitlements')
  if (raw) {
    try {
      return JSON.parse(raw) as Entitlements
    } catch { /* fall through to plan default */ }
  }
  const plan = h.get('x-tenant-plan')
  return entitlementsFor(isPlan(plan) ? plan : 'growth')
}
```

- [ ] **Step 5: Add the seat assertion (failing test first)**

Append to `lib/domain/staff.test.ts` (match its existing imports/`createTestDb` usage; add `assertStaffSeatAvailable` to the `./staff` import):

```ts
test('assertStaffSeatAvailable enforces the plan seat limit on active staff', async () => {
  const db = await createTestDb()
  await createStaff({ name: 'A', pin: '1111', role: 'admin' }, db)
  await createStaff({ name: 'B', pin: '2222' }, db)
  const twoSeats = { staffSeats: 2, listingSync: false, apiAccess: false }
  await assert.rejects(() => assertStaffSeatAvailable(twoSeats, db), domainCode('PLAN_LIMIT'))
  // Deactivated staff free their seat; unlimited plans never block.
  const b = await listStaff(db).then(s => s.find(x => x.name === 'B')!)
  await updateStaff(b.id, { isActive: false }, db)
  await assertStaffSeatAvailable(twoSeats, db) // no throw
  await assertStaffSeatAvailable({ staffSeats: null, listingSync: true, apiAccess: true }, db) // no throw
})
```

Run to see it fail, then append to `lib/domain/staff.ts`:

```ts
// Plan seat gating (spec §3.5): counts active staff only — deactivated
// members keep their history but free their seat.
export async function assertStaffSeatAvailable(ent: Entitlements, dbc: Db = db): Promise<void> {
  if (ent.staffSeats === null) return
  const active = await dbc.select({ id: staff.id }).from(staff).where(eq(staff.isActive, true))
  if (active.length >= ent.staffSeats) {
    throw new DomainError(
      'PLAN_LIMIT',
      `Your plan includes ${ent.staffSeats} staff seats — upgrade in Settings → Billing to add more`,
      { staffSeats: ent.staffSeats },
    )
  }
}
```

Add `import type { Entitlements } from '@/lib/plan'` to the imports. Run: seat test PASS.

- [ ] **Step 6: Gate the routes**

`app/api/staff/route.ts` POST — before `createStaff`:

```ts
import { getEntitlements } from '@/lib/entitlements'
import { assertStaffSeatAvailable } from '@/lib/domain/staff'
// …inside POST, after requireAdmin:
  await assertStaffSeatAvailable(await getEntitlements(), db)
```

`app/api/staff/[id]/route.ts` PATCH — reactivation consumes a seat; before `updateStaff`:

```ts
import { getEntitlements } from '@/lib/entitlements'
import { assertStaffSeatAvailable } from '@/lib/domain/staff'
// …inside PATCH, after parseBody:
  if (patch.isActive === true) await assertStaffSeatAvailable(await getEntitlements(), db)
```

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass (in single mode `getEntitlements()` returns pro, so existing staff tests/e2e are unaffected).

- [ ] **Step 8: Commit**

```bash
git add lib/platform/routing.ts lib/platform/routing.test.ts proxy.ts lib/entitlements.ts lib/domain/staff.ts lib/domain/staff.test.ts app/api/staff
git commit -m "feat: plan entitlement headers + staff seat gating"
```

---

### Task 10: Onboarding checklist

**Files:**
- Create: `lib/domain/onboarding.ts`
- Create: `lib/domain/onboarding.test.ts`
- Create: `app/api/onboarding/route.ts`
- Create: `components/onboarding/OnboardingChecklist.tsx`
- Modify: `app/(app)/layout.tsx` (fetch + render the card)
- Modify: `components/settings/SettingsForm.tsx` (mark the settings step done on save)

**Interfaces:**
- Consumes: `settings.onboarding` (Task 1; provisioning seeds `'{}'` in Task 5).
- Produces: `type OnboardingStepId = 'settings' | 'inventory' | 'sale' | 'staff'`; `interface OnboardingState { enabled: boolean; dismissedAt: string | null; steps: { id: OnboardingStepId; done: boolean }[] }`; `getOnboarding(dbc?: Db): Promise<OnboardingState>`; `markOnboardingStep(step: 'settings', dbc?: Db)`; `dismissOnboarding(dbc?: Db)`; `GET/POST /api/onboarding`.

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/onboarding.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { settings, staff } from '@/lib/db/schema'
import { getOnboarding, markOnboardingStep, dismissOnboarding } from './onboarding'

test('onboarding is disabled when the settings column is null (adopted shops)', async () => {
  const db = await createTestDb()
  await seedBase(db) // settings row with onboarding = null
  const s = await getOnboarding(db)
  assert.equal(s.enabled, false)
  await markOnboardingStep('settings', db) // must be a harmless no-op
  const [row] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(row.onboarding, null)
})

test('computes steps from data and stores manual marks + dismissal', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.update(settings).set({ onboarding: '{}' }).where(eq(settings.id, 1))

  let s = await getOnboarding(db)
  assert.equal(s.enabled, true)
  assert.equal(s.dismissedAt, null)
  assert.deepEqual(s.steps, [
    { id: 'settings', done: false },
    { id: 'inventory', done: false }, // 0 items < 5
    { id: 'sale', done: false },      // 0 sales
    { id: 'staff', done: false },     // 1 member (the setup admin) < 2
  ])

  await markOnboardingStep('settings', db)
  await db.insert(staff).values({ name: 'Second', pinHash: 'x', role: 'staff' })
  s = await getOnboarding(db)
  assert.deepEqual(s.steps.filter(x => x.done).map(x => x.id), ['settings', 'staff'])

  await dismissOnboarding(db)
  s = await getOnboarding(db)
  assert.ok(s.dismissedAt)
})
```

Run: `npm test 2>&1 | grep -B2 -A4 onboarding` — Expected: FAIL — `Cannot find module './onboarding'`

- [ ] **Step 2: Create `lib/domain/onboarding.ts`**

```ts
import { count, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { settings, inventoryItems, sales, staff } from '@/lib/db/schema'

// First-login onboarding checklist (spec §3.6). Enabled only where
// provisioning seeded settings.onboarding = '{}' — adopted Wizard-of-Oz and
// single-tenant shops keep null and never see it. Data-derived steps are
// computed live (no drift); the settings step is a stored manual mark.

export type OnboardingStepId = 'settings' | 'inventory' | 'sale' | 'staff'

export interface OnboardingState {
  enabled: boolean
  dismissedAt: string | null
  steps: { id: OnboardingStepId; done: boolean }[]
}

interface Stored {
  dismissedAt?: string
  done?: OnboardingStepId[]
}

const DISABLED: OnboardingState = { enabled: false, dismissedAt: null, steps: [] }

export async function getOnboarding(dbc: Db = db): Promise<OnboardingState> {
  const [row] = await dbc.select({ onboarding: settings.onboarding }).from(settings).limit(1)
  if (!row?.onboarding) return DISABLED
  const stored = parseStored(row.onboarding)
  const [[inv], [sal], [stf]] = await Promise.all([
    dbc.select({ n: count() }).from(inventoryItems),
    dbc.select({ n: count() }).from(sales),
    dbc.select({ n: count() }).from(staff),
  ])
  return {
    enabled: true,
    dismissedAt: stored.dismissedAt ?? null,
    steps: [
      { id: 'settings', done: stored.done?.includes('settings') ?? false },
      { id: 'inventory', done: inv.n >= 5 },
      { id: 'sale', done: sal.n >= 1 },
      { id: 'staff', done: stf.n >= 2 }, // beyond the admin created at setup
    ],
  }
}

export async function markOnboardingStep(step: 'settings', dbc: Db = db): Promise<void> {
  await patchStored(s => ({ ...s, done: [...new Set([...(s.done ?? []), step])] }), dbc)
}

export async function dismissOnboarding(dbc: Db = db): Promise<void> {
  await patchStored(s => ({ ...s, dismissedAt: new Date().toISOString() }), dbc)
}

async function patchStored(fn: (s: Stored) => Stored, dbc: Db): Promise<void> {
  const [row] = await dbc.select({ onboarding: settings.onboarding }).from(settings).limit(1)
  if (!row?.onboarding) return // disabled — no-op
  await dbc.update(settings)
    .set({ onboarding: JSON.stringify(fn(parseStored(row.onboarding))) })
    .where(eq(settings.id, 1))
}

function parseStored(raw: string): Stored {
  try {
    return JSON.parse(raw) as Stored
  } catch {
    return {}
  }
}
```

Run: `npm test 2>&1 | grep -A3 onboarding` — Expected: PASS.

- [ ] **Step 3: Create the API route**

Create `app/api/onboarding/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { getOnboarding, markOnboardingStep, dismissOnboarding } from '@/lib/domain/onboarding'

const onboardingBody = z.object({
  step: z.literal('settings').optional(),
  dismiss: z.boolean().optional(),
})

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getOnboarding(db))
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const { step, dismiss } = await parseBody(req, onboardingBody)
  if (step) await markOnboardingStep(step, db)
  if (dismiss) await dismissOnboarding(db)
  return NextResponse.json(await getOnboarding(db))
})
```

- [ ] **Step 4: Create the checklist card**

Create `components/onboarding/OnboardingChecklist.tsx`:

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Circle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { OnboardingState, OnboardingStepId } from '@/lib/domain/onboarding'
// ^ type-only import: erased at compile, so no lib/db in the client bundle.

const STEP_META: Record<OnboardingStepId, { label: string; href: string }> = {
  settings: { label: 'Check your pricing margins and VAT scheme', href: '/settings' },
  inventory: { label: 'Add your first 5 cards (or import a CSV)', href: '/inventory' },
  sale: { label: 'Ring up a test sale', href: '/pos' },
  staff: { label: 'Add PINs for your staff', href: '/settings' },
}

export function OnboardingChecklist({ initial }: { initial: OnboardingState }) {
  const [state, setState] = useState(initial)
  if (!state.enabled || state.dismissedAt) return null
  const remaining = state.steps.filter(s => !s.done).length
  if (remaining === 0) return null

  async function dismiss() {
    setState({ ...state, dismissedAt: new Date().toISOString() })
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dismiss: true }),
    }).catch(() => {})
  }

  return (
    <div className="container mx-auto px-4 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Getting started</h2>
            <p className="text-sm text-muted-foreground">
              {remaining} step{remaining === 1 ? '' : 's'} to go — most shops are transacting within the hour.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss checklist">
            <X className="size-4" />
          </Button>
        </div>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {state.steps.map((s) => (
            <li key={s.id}>
              <Link href={STEP_META[s.id].href}
                className="flex items-center gap-2 text-sm hover:underline">
                {s.done
                  ? <CheckCircle2 className="size-4 text-green-600" aria-hidden />
                  : <Circle className="size-4 text-muted-foreground" aria-hidden />}
                <span className={s.done ? 'text-muted-foreground line-through' : ''}>{STEP_META[s.id].label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Render it from the app layout**

In `app/(app)/layout.tsx`, extend the parallel fetch and render above `<main>`:

```tsx
import { getOnboarding } from '@/lib/domain/onboarding'
import { OnboardingChecklist } from '@/components/onboarding/OnboardingChecklist'
// …
  const [settings, inStockWantsCount, onboarding] = await Promise.all([
    getSettings(db),
    countInStockWants(db),
    getOnboarding(db),
  ])
// …between <Nav …/> and <main …>:
        {onboarding.enabled && <OnboardingChecklist initial={onboarding} />}
```

- [ ] **Step 6: Mark the settings step on save**

In `components/settings/SettingsForm.tsx`, in the submit handler's success path (right after the saved-toast/state update), add a fire-and-forget mark:

```ts
      // Reviewing settings is the one onboarding step we can't infer from data.
      fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'settings' }),
      }).catch(() => {})
```

(The endpoint no-ops when onboarding is disabled, so this is safe for every install.)

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass — including the tenancy-guard server-component sweep (the layout calls `getOnboarding(db)` with an explicit handle).

- [ ] **Step 8: Commit**

```bash
git add lib/domain/onboarding.ts lib/domain/onboarding.test.ts app/api/onboarding components/onboarding "app/(app)/layout.tsx" components/settings/SettingsForm.tsx
git commit -m "feat: first-login onboarding checklist for provisioned shops"
```

---

### Task 11: Billing surface — settings card, portal, past-due banner

**Files:**
- Modify: `lib/platform/tenants.ts` (add `getTenantById`)
- Modify: `lib/platform/tenants.test.ts` (cover it)
- Modify: `lib/auth.ts` (add `currentTenantStatus`)
- Create: `app/api/billing/route.ts`
- Create: `app/api/billing/portal/route.ts`
- Create: `components/settings/BillingCard.tsx`
- Create: `components/shared/BillingBanner.tsx`
- Modify: `app/(app)/settings/page.tsx` (render BillingCard in multi mode)
- Modify: `app/(app)/layout.tsx` (render BillingBanner when past_due)
- Modify: `proxy.ts` (blocked tenants: JSON for API paths — Phase 1 review follow-up)

**Interfaces:**
- Consumes: `getStripe` (Task 6), `PLANS` (Task 2), `x-tenant-status` header (Phase 1).
- Produces: `getTenantById(id: number, opts?: { db?: PlatformDb }): Promise<Tenant | null>`; `currentTenantStatus(): Promise<string | undefined>`; `GET /api/billing` → `{ managed, plan, status, trialEndsAt, cancelAtPeriodEnd }`; `POST /api/billing/portal` → `{ url }` (Stripe customer portal session — the spec's "we build no billing UI").

- [ ] **Step 1: Add `getTenantById` (failing test first)**

Append to `lib/platform/tenants.test.ts` (add `getTenantById` to the `./tenants` import):

```ts
test('getTenantById fetches without caching', async () => {
  const pdb = await createTestPlatformDb()
  const [t] = await pdb.insert(tenants).values({ slug: 'by-id', name: 'By Id', dbUrl: 'file:x.db' }).returning()
  const found = await getTenantById(t.id, { db: pdb })
  assert.equal(found?.slug, 'by-id')
  assert.equal(await getTenantById(999999, { db: pdb }), null)
})
```

Run to see it fail, then append to `lib/platform/tenants.ts`:

```ts
// Uncached: used by low-traffic authenticated billing routes where staleness
// (plan just changed in the portal) would be visible.
export async function getTenantById(id: number, opts: { db?: PlatformDb } = {}): Promise<Tenant | null> {
  const pdb = opts.db ?? getPlatformDb()
  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return tenant ?? null
}
```

Run: PASS.

- [ ] **Step 2: Add `currentTenantStatus` to `lib/auth.ts`**

Below `currentTenantId`:

```ts
// Billing status of the current tenant, from proxy-injected headers
// (multi mode only) — drives the past-due banner.
export async function currentTenantStatus(): Promise<string | undefined> {
  if (process.env.TENANCY_MODE !== 'multi') return undefined
  const { headers } = await import('next/headers')
  return (await headers()).get('x-tenant-status') ?? undefined
}
```

- [ ] **Step 3: Create the billing routes**

Create `app/api/billing/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { getTenantById } from '@/lib/platform/tenants'
import { getStripe } from '@/lib/platform/stripe'

// Billing facts for the settings card. Read-only; all changes happen in the
// Stripe customer portal (spec §3.5 — no billing UI of our own).
export const GET = guarded(async () => {
  if (!isMultiTenant()) return NextResponse.json({ managed: false })
  const session = await getSession(await currentTenantId())
  if (!session.isOwnerLoggedIn && session.staffRole !== 'admin') {
    throw new DomainError('UNAUTHORIZED', 'Login required')
  }
  const tenantId = await currentTenantId()
  const tenant = tenantId ? await getTenantById(Number(tenantId)) : null
  if (!tenant) throw new DomainError('NOT_FOUND', 'Tenant not found')

  let trialEndsAt: number | null = null
  let cancelAtPeriodEnd = false
  if (tenant.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const sub = await getStripe().subscriptions.retrieve(tenant.stripeSubscriptionId)
      trialEndsAt = sub.trial_end ?? null
      cancelAtPeriodEnd = sub.cancel_at_period_end ?? false
    } catch { /* registry facts still render */ }
  }
  return NextResponse.json({
    managed: true,
    plan: tenant.plan,
    status: tenant.status,
    trialEndsAt,
    cancelAtPeriodEnd,
  })
})
```

Create `app/api/billing/portal/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { getSession, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { getTenantById } from '@/lib/platform/tenants'
import { getStripe } from '@/lib/platform/stripe'

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const session = await getSession(await currentTenantId())
  if (!session.isOwnerLoggedIn && session.staffRole !== 'admin') {
    throw new DomainError('UNAUTHORIZED', 'Login required')
  }
  const tenantId = await currentTenantId()
  const tenant = tenantId ? await getTenantById(Number(tenantId)) : null
  if (!tenant?.stripeCustomerId) throw new DomainError('NOT_FOUND', 'No billing account for this shop')
  const portal = await getStripe().billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${req.nextUrl.origin}/settings`,
  })
  return NextResponse.json({ url: portal.url })
})
```

- [ ] **Step 4: Create the components**

Create `components/settings/BillingCard.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { PLANS, isPlan } from '@/lib/plan'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface Billing {
  managed: boolean
  plan?: string
  status?: string
  trialEndsAt?: number | null
  cancelAtPeriodEnd?: boolean
}

const STATUS_COPY: Record<string, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment overdue',
  paused: 'Paused',
}

export function BillingCard() {
  const [billing, setBilling] = useState<Billing | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/billing').then(r => (r.ok ? r.json() : null)).then(setBilling).catch(() => setBilling(null))
  }, [])

  if (!billing?.managed) return null
  const planLabel = isPlan(billing.plan) ? `${PLANS[billing.plan].label} — £${PLANS[billing.plan].pricePence / 100}/month` : billing.plan
  const daysLeft = billing.trialEndsAt ? Math.max(0, Math.ceil((billing.trialEndsAt * 1000 - Date.now()) / 86_400_000)) : null

  async function openPortal() {
    setBusy(true)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const body = await res.json()
      if (res.ok && body.url) window.location.href = body.url
      else setBusy(false)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Billing</h2>
        <Badge variant={billing.status === 'past_due' ? 'destructive' : 'secondary'}>
          {STATUS_COPY[billing.status ?? ''] ?? billing.status}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{planLabel}</p>
      {billing.status === 'trialing' && daysLeft !== null && (
        <p className="text-sm text-muted-foreground">
          {daysLeft} day{daysLeft === 1 ? '' : 's'} left in your trial — add a card to keep trading after it ends.
        </p>
      )}
      {billing.cancelAtPeriodEnd && (
        <p className="text-sm text-muted-foreground">Your subscription is set to cancel at the end of the period.</p>
      )}
      <Button onClick={openPortal} disabled={busy} variant="outline">
        {busy ? 'Opening…' : 'Manage billing'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Change plan, update your card, download invoices or cancel — handled securely by Stripe.
      </p>
    </div>
  )
}
```

Create `components/shared/BillingBanner.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function BillingBanner() {
  const [busy, setBusy] = useState(false)

  async function openPortal() {
    setBusy(true)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const body = await res.json()
      if (res.ok && body.url) window.location.href = body.url
      else setBusy(false)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="bg-destructive/10 border-b border-destructive/30 text-sm">
      <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-2">
        <p>Your last payment failed — please update your card to keep the shop running.</p>
        <Button size="sm" variant="outline" onClick={openPortal} disabled={busy}>
          {busy ? 'Opening…' : 'Update card'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Wire into settings page and layout**

`app/(app)/settings/page.tsx`:

```tsx
import { BillingCard } from '@/components/settings/BillingCard'
// …inside the returned <div>, after <StaffSection />:
      {process.env.TENANCY_MODE === 'multi' && <BillingCard />}
```

`app/(app)/layout.tsx` — fetch the status and render the banner above the checklist:

```tsx
import { currentTenantStatus } from '@/lib/auth'
// …in the component body:
  const tenantStatus = await currentTenantStatus()
// …directly after <Nav …/>:
        {tenantStatus === 'past_due' && <BillingBanner />}
```

(with `import { BillingBanner } from '@/components/shared/BillingBanner'`.)

- [ ] **Step 6: Blocked tenants answer API calls with JSON**

Phase 1 review follow-up, now relevant because this phase is what actually suspends shops: the proxy currently rewrites *every* blocked-tenant path to the `/suspended` HTML page, so an open till's `fetch` calls would get a 200 HTML body. In `proxy.ts`, inside the `blocked` branch, before the rewrite:

```ts
      // API calls from a still-open till get a machine-readable answer,
      // not a rewritten HTML lock screen.
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'This shop is currently unavailable', code: 'SHOP_UNAVAILABLE' },
          { status: 403 },
        )
      }
```

(Verified by the runbook's lifecycle walkthrough: with a suspended tenant, `curl http://<slug>.localhost:3000/api/settings` returns the 403 JSON.)

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/platform/tenants.ts lib/platform/tenants.test.ts lib/auth.ts app/api/billing components/settings/BillingCard.tsx components/shared/BillingBanner.tsx "app/(app)/settings/page.tsx" "app/(app)/layout.tsx" proxy.ts
git commit -m "feat: billing card + Stripe portal handoff + past-due banner + JSON for blocked API calls"
```

---

### Task 12: Runbook, env docs, AGENTS.md, exit-test walkthrough

**Files:**
- Create: `docs/runbooks/stripe-billing-setup.md`
- Modify: `AGENTS.md` (multi-tenancy section: billing pointer)

**Interfaces:**
- Produces: the founder-facing Stripe/Resend/Turso configuration runbook and the Phase 2 exit-test script (spec Part 4: "cold signup → trial → live shop processing a sale, card-less; payment-failed → dunning → suspend path exercised via Stripe test clocks").

- [ ] **Step 1: Write `docs/runbooks/stripe-billing-setup.md`**

```markdown
# Stripe Billing + provisioning — setup & test runbook

## One-time Stripe dashboard setup (test mode first, then live)

1. **Products/prices**: create three products — Starter, Growth, Pro — each with one
   recurring monthly GBP price (£39 / £79 / £149). Set tax behaviour to *exclusive* and
   enable **Stripe Tax** (UK VAT 20% is added on top; register the VAT number in
   Settings → Tax). Copy the three price ids into env (below).
2. **Customer portal** (Settings → Billing → Customer portal): enable payment-method
   update, invoice history, cancellation (at period end), and plan switches between the
   three prices. Set the business name/branding.
3. **Emails** (Settings → Emails): turn on Stripe's "send emails about expiring cards"
   and failed-payment receipts — they complement our dunning email.
4. **Webhook endpoint** (Developers → Webhooks): endpoint
   `https://www.<PLATFORM_BASE_HOST>/api/platform/stripe`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.trial_will_end`,
   `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. **Smart retries** (Settings → Billing → Revenue recovery): keep defaults (retries for
   ~1 week, then cancel the subscription — that cancellation is what suspends the shop).

## Environment variables (platform deployment only)

| Var | Value |
|---|---|
| `TENANCY_MODE` | `multi` |
| `PLATFORM_BASE_HOST` | e.g. `example-brand.co.uk` (no scheme, no port) |
| `PLATFORM_DATABASE_URL` / `PLATFORM_AUTH_TOKEN` | registry DB |
| `TURSO_GROUP_AUTH_TOKEN` | group token for tenant DBs |
| `TURSO_API_TOKEN` / `TURSO_ORG` / `TURSO_GROUP` | platform API for DB creation (group in `fra`); unset TOKEN = local file DBs (dev) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | from the dashboard |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_PRO` | the three price ids |
| `RESEND_API_KEY` / `EMAIL_FROM` | e.g. `Brand <hello@example-brand.co.uk>`; unset = emails logged to console |
| `CRON_SECRET` | also authorises the internal seed-catalogue job |
| `SESSION_SECRET` | shared session key |
| `NEXT_PUBLIC_BRAND_BASE_HOST` | cosmetic subdomain suffix on the signup form |

## Local end-to-end walkthrough (no cloud credentials needed)

```bash
# Terminal 1 — the platform, file-backed registry + tenant DBs:
TENANCY_MODE=multi PLATFORM_BASE_HOST=localhost \
PLATFORM_DATABASE_URL=file:./platform-dev.db \
STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_…(from stripe listen) \
STRIPE_PRICE_STARTER=price_… STRIPE_PRICE_GROWTH=price_… STRIPE_PRICE_PRO=price_… \
CRON_SECRET=dev-secret npm run dev

# Terminal 2 — forward webhooks:
stripe listen --forward-to localhost:3000/api/platform/stripe
```

1. Visit `http://localhost:3000/signup`, pick Growth, submit → Stripe Checkout
   (test mode, no card fields — trial). Complete it.
2. Watch the dev server log: webhook → provision → `[email skipped]` welcome email with
   the setup link. Open the link (`http://<slug>.localhost:3000/setup?token=…`).
3. Set password + PIN → you land in the app with the onboarding checklist. The catalogue
   seed job runs in the background (or run it by hand:
   `curl -X POST -H "Authorization: Bearer dev-secret" -H "content-type: application/json" -d '{"tenantId":1}' http://localhost:3000/api/platform/jobs/seed-catalogue`).
4. Add an inventory item, ring up a sale. **That's the Phase 2 exit test's first half.**

## Lifecycle exit test (Stripe test clocks)

Checkout can't attach customers to test clocks, so drive the lifecycle with a
clock-created subscription wired to the tenant by hand:

```bash
stripe test_clocks create --frozen-time $(date +%s)          # note tc_…
stripe customers create --test-clock tc_… --email brad@example.com   # note cus_…
stripe subscriptions create --customer cus_… \
  -d "items[0][price]"=$STRIPE_PRICE_GROWTH \
  -d trial_period_days=14 \
  -d "trial_settings[end_behavior][missing_payment_method]"=pause    # note sub_…
# Point the provisioned tenant at this pair:
sqlite3 platform-dev.db "UPDATE tenants SET stripe_customer_id='cus_…', stripe_subscription_id='sub_…' WHERE slug='<slug>';"
```

Then advance the clock and check after each step (`stripe test_clocks advance tc_… --to <epoch>`):

- [ ] **+11 days** → `customer.subscription.trial_will_end` → trial-ending email logged.
- [ ] **+14 days, no card** → subscription pauses → tenant `status=paused` → shop shows the
      lock screen. (Resume by attaching test card `4242…` via the portal, advance again → active.)
- [ ] **Failing payment**: attach test card `4000 0000 0000 0341` to the customer as the
      default, resume/advance past trial → `invoice.payment_failed` → dunning email logged,
      tenant `past_due`, shop shows the red banner with "Update card".
- [ ] **Let Smart Retries exhaust** (keep advancing) → `customer.subscription.deleted` →
      tenant `suspended` + suspension email → lock screen.
- [ ] `stripe trigger checkout.session.completed` (fixture without our metadata) →
      webhook answers `ignored:not-signup`; redeliver a processed event from the dashboard →
      `duplicate`.

## Notes

- Provisioning failures: the webhook 500s, the `stripe_events` claim is released and
  Stripe retries with backoff (up to ~3 days). `provisionTenant` is idempotent by slug, so
  retries resume. If retries exhaust, re-send the event from the Stripe dashboard once the
  cause is fixed; `platform_audit` rows carry the trail.
- A tenant whose catalogue seed died mid-run is completed by the nightly
  `/api/cron/sync-prices` sweep — no action needed.
- Wizard-of-Oz shops: unchanged (single-tenant runbook still applies); adopt into the
  platform later via `scripts/create-tenant.ts --skip-migrations` + setting their plan and
  Stripe ids as above.
```

- [ ] **Step 2: Update `AGENTS.md`**

Append one bullet to the "Multi-tenancy (platform layer)" section:

```markdown
- Billing/provisioning (Phase 2): Stripe Checkout + webhooks (`app/api/platform/stripe`,
  idempotent via `stripe_events`) drive the tenant lifecycle; `provisionTenant`
  (`lib/platform/provision.ts`) is idempotent by slug; plan gating via `lib/plan.ts` +
  `getEntitlements()`. Env + dashboard setup and the test-clock walkthrough:
  `docs/runbooks/stripe-billing-setup.md`.
```

- [ ] **Step 3: Final verification**

Run each and confirm:

```bash
npm test          # all green, including the ~20 new test files' cases
npm run lint      # clean
npm run test:e2e  # single-tenant Playwright smoke still green (proves TENANCY_MODE-unset is untouched)
```

Then the local walkthrough from the runbook (signup → provision → setup → sale) once, end to end, with `stripe listen` running.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/stripe-billing-setup.md AGENTS.md
git commit -m "docs: Stripe billing setup runbook + AGENTS.md platform notes"
```

---

## Deferred (explicitly not in this plan)

- **Day-4 trial-engagement email** — needs a scheduler + per-tenant send markers; the
  webhook-driven trial-ending email covers the conversion-critical touch. Ride Phase 3's
  cron work.
- **Cancelled → 30-day export window → automated deletion** (spec §3.10) — Phase 3, with
  the full-shop export it depends on.
- **Platform admin dashboard, Sentry, backups, PostHog/Crisp, cursor-staggered sync** —
  Phase 3 (spec Part 4).
- **Annual "12-for-10" prices** — ~Week 12, dashboard-only change plus a second price id
  per plan.
- **`paused` self-serve £9 retention plan** — status is modelled and routed (lock screen);
  the discounted price/copy is a later commercial decision.
- **Calendly link in the welcome email** (spec §3.6 mentions one) — no booking URL exists
  yet; add the line to `welcomeEmail` in `lib/platform/emails.ts` once the founder has one.
- **Phase 1 review follow-ups deferred to Phase 3**: multi-mode render-smoke e2e (boot
  Playwright with `TENANCY_MODE=multi` against two file tenants); LRU caps on the tenant
  slug cache (`lib/platform/tenants.ts`) and tenant client map (`lib/db/index.ts`) —
  unbounded today, inflatable by subdomain probing. (The third follow-up — blocked-tenant
  API calls returning HTML — ships here in Task 11.)
