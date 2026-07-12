# Platform Foundation + Tenancy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phases 0–1 of the SaaS spec (`docs/superpowers/specs/2026-07-11-saas-platform-architecture.md`): brand config + health endpoint + Wizard-of-Oz runbook, then the multi-tenant core — platform registry DB, subdomain tenant resolution in `proxy.ts`, per-request tenant `Db`, and per-tenant owner auth — all behind a `TENANCY_MODE` flag that defaults to today's single-tenant behaviour.

**Architecture:** Database-per-tenant on Turso. A new platform *registry* DB (separate schema/client under `lib/platform/`) maps subdomain slug → tenant DB. `proxy.ts` resolves the tenant per request and injects trusted `x-tenant-*` headers; `getTenantDb()` in `lib/db` returns the tenant's cached drizzle client (or the existing singleton in single mode). The domain layer is untouched — it already accepts a `Db` handle; routes change from importing the singleton to passing an explicit handle.

**Tech Stack:** Next.js 16 App Router (`proxy.ts`, not `middleware.ts`), Drizzle + `@libsql/client`, iron-session, node test runner via tsx.

## Global Constraints

- **Money is integer pence** — untouched here, but never introduce floats in anything you write.
- **Client components must never value-import `lib/domain/*`, `lib/db`, or `lib/platform/*`** (libsql in the browser graph breaks the dev server). `lib/brand.ts` must stay dependency-free and client-safe.
- **`TENANCY_MODE` unset or any value ≠ `'multi'` means single-tenant** — `npm test`, `npm run test:e2e`, dev, and Wizard-of-Oz deployments must behave exactly as today with no new env vars required.
- **Tenant DB schema changes in this plan: exactly one** — migration adding `settings.owner_password_hash` (nullable). Nothing else in `lib/db/schema.ts` changes.
- New/changed API routes must use `guarded()` (`lib/api.ts`) and zod `parseBody()` (`lib/validation.ts`).
- New env vars introduced (all optional in single mode): `TENANCY_MODE`, `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN`, `PLATFORM_BASE_HOST` (e.g. `example-brand.co.uk`), `TURSO_GROUP_AUTH_TOKEN`, `NEXT_PUBLIC_BRAND_NAME`.
- UK English in all user-visible copy.
- Run `npm test` from the repo root; it sets `TURSO_DATABASE_URL=:memory:` itself.
- Commit after every task (small commits, `feat:`/`docs:`/`refactor:` prefixes).

---

### Task 1: Brand module + cookie rename

**Files:**
- Create: `lib/brand.ts`
- Create: `lib/brand.test.ts`
- Modify: `lib/auth.ts:14` (cookie name)
- Modify: `app/layout.tsx:17` (title)
- Modify: `components/layout/Nav.tsx:15` (default shopName)
- Modify: `components/shared/SettingsProvider.tsx:15` (fallback shopName)
- Modify: `lib/settings.ts:22` (default shopName)

**Interfaces:**
- Produces: `BRAND: { name: string; productName: string; supportEmail: string }` from `lib/brand.ts` — client-safe, dependency-free. Later tasks and Phase 2 (emails) import this.

- [ ] **Step 1: Write the failing test**

Create `lib/brand.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { BRAND } from './brand'

test('brand has a name and support email', () => {
  assert.ok(BRAND.name.length > 0)
  assert.ok(BRAND.supportEmail.includes('@'))
})

test('brand name is a plain string (no template artifacts)', () => {
  assert.ok(!BRAND.name.includes('undefined'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 brand`
Expected: FAIL — `Cannot find module './brand'`

- [ ] **Step 3: Create `lib/brand.ts`**

```ts
// Single point of change for the product rename (see
// docs/superpowers/specs/2026-07-11-saas-platform-architecture.md §3.11).
// Client-safe: no imports, reads only NEXT_PUBLIC_ env (inlined at build).
export const BRAND = {
  // Shop-facing product name. Defaults to the working title until the
  // trademark-checked name is chosen; then one env var renames everything.
  name: process.env.NEXT_PUBLIC_BRAND_NAME || 'PokeDB',
  productName: `${process.env.NEXT_PUBLIC_BRAND_NAME || 'PokeDB'} — Card Shop POS`,
  supportEmail: process.env.NEXT_PUBLIC_BRAND_SUPPORT_EMAIL || 'support@example.com',
} as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -B1 -A3 brand`
Expected: PASS (2 tests)

- [ ] **Step 5: Route existing brand strings through the module**

In `lib/auth.ts`, change the cookie name (brand-neutral, not brand-derived — cookie names shouldn't churn on rename):

```ts
  cookieName: 'shop-session',
```

In `app/layout.tsx` (line 17), replace the literal title:

```tsx
import { BRAND } from '@/lib/brand'
// …
  title: BRAND.productName,
```

In `components/layout/Nav.tsx` (client component — `lib/brand.ts` is safe to import):

```tsx
import { BRAND } from '@/lib/brand'
// …
export function Nav({ shopName = BRAND.name, staffName, staffRole, inStockWantsCount = 0 }: NavProps) {
```

In `components/shared/SettingsProvider.tsx` line 15, replace `shopName: 'PokeDB'` with `shopName: BRAND.name` (add the import).

In `lib/settings.ts` line 22, replace `shopName: 'PokeDB'` with `shopName: BRAND.name` (add the import).

Do NOT change `lib/db/schema.ts:115` (`default('PokeDB')`) — a schema default change means a pointless migration; Phase 2 provisioning seeds the real shop name at signup.

- [ ] **Step 6: Verify suite + lint**

Run: `npm test && npm run lint`
Expected: all pass. (Cookie rename logs existing dev sessions out — expected.)

- [ ] **Step 7: Commit**

```bash
git add lib/brand.ts lib/brand.test.ts lib/auth.ts app/layout.tsx components/layout/Nav.tsx components/shared/SettingsProvider.tsx lib/settings.ts
git commit -m "feat: centralise brand strings in lib/brand.ts, rename session cookie"
```

---

### Task 2: Health endpoint

**Files:**
- Create: `app/api/health/route.ts`
- Create: `app/api/health/route.test.ts`
- Modify: `proxy.ts:5` (PUBLIC_PATHS)

**Interfaces:**
- Produces: `GET /api/health` → `200 {"ok":true,"db":true}` (or `503 {"ok":false,"db":false}`), unauthenticated. UptimeRobot points here (Phase 3 wires monitoring; Task 6 makes it registry-aware in multi mode — for now it pings the default db).

- [ ] **Step 1: Write the failing test**

Create `app/api/health/route.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { GET } from './route'

test('health returns ok with db reachable', async () => {
  const res = await GET()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, db: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B1 -A5 health`
Expected: FAIL — cannot find `./route`

- [ ] **Step 3: Implement `app/api/health/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

// Unauthenticated liveness check for uptime monitoring. Verifies the app is
// serving and its default database answers a trivial query.
export async function GET() {
  try {
    await db.run(sql`select 1`)
    return NextResponse.json({ ok: true, db: true })
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -B1 -A5 health`
Expected: PASS

- [ ] **Step 5: Make the path public in `proxy.ts`**

```ts
const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/cron/', '/api/health']
```

- [ ] **Step 6: Full suite**

Run: `npm test && npm run lint`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/health proxy.ts
git commit -m "feat: unauthenticated /api/health endpoint for uptime monitoring"
```

---

### Task 3: Wizard-of-Oz deployment runbook

**Files:**
- Create: `docs/runbooks/wizard-of-oz-shop-deploy.md`

**Interfaces:** none (documentation). Content below is the complete file — write it verbatim, it encodes real repo gotchas.

- [ ] **Step 1: Write the runbook**

````markdown
# Runbook: deploy a single-tenant beta shop (Wizard-of-Oz)

Deploys one shop on its own Vercel project + Turso DB using the codebase as-is
(`TENANCY_MODE` unset = single-tenant). Target: ~30 minutes per shop.
This is the validation-phase model from the master plan and the standing
fallback if the multi-tenant build slips (cap: ~10 shops).

## 1. Create the database (EU region for UK GDPR)

```bash
turso db create shop-<slug> --location fra
turso db show shop-<slug> --url        # → TURSO_DATABASE_URL
turso db tokens create shop-<slug>     # → TURSO_AUTH_TOKEN
```

## 2. Apply migrations

**Gotcha:** `drizzle-kit` reads `TURSO_*` from your shell, which overrides
`.env.local`. Point the shell vars at the NEW shop DB explicitly:

```bash
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx drizzle-kit migrate
```

## 3. Seed catalogue + staff

```bash
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx tsx scripts/import-catalogue.ts
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx tsx scripts/seed-staff.ts
```

Catalogue import takes several minutes (~20K cards; idempotent — safe to re-run).

## 4. Create the Vercel project

New Vercel project from this repo (one per shop), then set env vars
(Production):

| Var | Value |
|---|---|
| `TURSO_DATABASE_URL` | from step 1 |
| `TURSO_AUTH_TOKEN` | from step 1 |
| `SESSION_SECRET` | `openssl rand -base64 32` (unique per shop) |
| `OWNER_PASSWORD_HASH` | bcrypt hash of the shop's owner password (`npx tsx -e "import('bcryptjs').then(async b=>console.log(await b.hash(process.argv[1],10)))" 'THE-PASSWORD'`) |
| `CRON_SECRET` | `openssl rand -hex 24` (unique per shop) |
| `PRICE_USD_TO_GBP` / `PRICE_EUR_TO_GBP` | current rates, e.g. `0.79` / `0.86` |
| `NEXT_PUBLIC_BRAND_NAME` | the (post-rename) brand name |

**Gotcha:** this Next version's env parser expands `$` in values — escape as
`\$` (see `.env.test` for the precedent).

Add the price-sync cron in the Vercel project (Settings → Cron Jobs):
`GET /api/cron/sync-prices`, daily, header `Authorization: Bearer <CRON_SECRET>`.

Assign the domain: `<slug>.<base-domain>` → this project.

## 5. Smoke-check (5 minutes)

- [ ] `https://<slug>.<domain>/api/health` → `{"ok":true,"db":true}`
- [ ] Owner login works; set staff PINs in Settings → Staff
- [ ] Shop name + margins configured in Settings
- [ ] Search a card at the POS, sell it, refund it
- [ ] Buylist: price a card, complete a buy
- [ ] Trigger the cron once manually and confirm prices populate

## 6. Onboarding (from the ops report)

Book the 30-minute Zoom; import their inventory CSV via Inventory → Import;
shop owner processes one real transaction before the call ends.

## Adopting into the platform later

The shop's Turso DB **is** a valid tenant DB. When multi-tenancy ships,
adoption = insert a registry row pointing at this DB (no data migration),
move the subdomain to the platform project, retire the per-shop Vercel project.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/wizard-of-oz-shop-deploy.md
git commit -m "docs: Wizard-of-Oz single-tenant shop deployment runbook"
```

---

### Task 4: Platform registry — schema, client, migrations

**Files:**
- Create: `lib/platform/schema.ts`
- Create: `lib/platform/db.ts`
- Create: `lib/platform/test-helpers.ts`
- Create: `lib/platform/schema.test.ts`
- Create: `drizzle-platform.config.ts`
- Create (generated): `lib/platform/migrations/*`

**Interfaces:**
- Produces:
  - `tenants` table + `Tenant` type: `{ id: number; slug: string; name: string; status: 'trialing'|'active'|'past_due'|'paused'|'suspended'|'cancelled'; plan: 'starter'|'growth'|'pro'; stripeCustomerId: string|null; stripeSubscriptionId: string|null; tursoDbName: string|null; dbUrl: string; region: string; setupToken: string|null; setupCompletedAt: number|null; entitlementOverrides: string|null; createdAt: number; updatedAt: number }`
  - `getPlatformDb(): PlatformDb` — lazy singleton for the registry (env `PLATFORM_DATABASE_URL` / `PLATFORM_AUTH_TOKEN`)
  - `createTestPlatformDb(): Promise<PlatformDb>` from test-helpers (file-backed temp DB with migrations applied)

- [ ] **Step 1: Write the failing test**

Create `lib/platform/schema.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestPlatformDb } from './test-helpers'
import { tenants, stripeEvents } from './schema'

test('registry stores and retrieves a tenant by slug', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'brads-cards', name: "Brad's Cards", dbUrl: 'file:/tmp/x.db' })
  const [row] = await pdb.select().from(tenants).where(eq(tenants.slug, 'brads-cards'))
  assert.equal(row.name, "Brad's Cards")
  assert.equal(row.status, 'trialing') // default status
  assert.equal(row.plan, 'growth')     // default plan (research: the sweet-spot tier)
  assert.equal(row.region, 'fra')      // default region (EU for GDPR)
})

test('duplicate slugs are rejected', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'dupe', name: 'A', dbUrl: 'file:/tmp/a.db' })
  await assert.rejects(
    pdb.insert(tenants).values({ slug: 'dupe', name: 'B', dbUrl: 'file:/tmp/b.db' }),
  )
})

test('stripe event ids are unique (webhook idempotency)', async () => {
  const pdb = await createTestPlatformDb()
  await pdb.insert(stripeEvents).values({ stripeEventId: 'evt_1', type: 'checkout.session.completed' })
  await assert.rejects(
    pdb.insert(stripeEvents).values({ stripeEventId: 'evt_1', type: 'checkout.session.completed' }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B1 -A5 "registry\|platform"`
Expected: FAIL — cannot find `./test-helpers` / `./schema`

- [ ] **Step 3: Create `lib/platform/schema.ts`**

Follow the existing `lib/db/schema.ts` idiom (integer epoch-seconds timestamps via `sql`, text enums as plain text columns with defaults):

```ts
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Platform registry: commercial facts about tenants. Shop data never lives
// here; this DB is never touched by shop-facing domain code.

export const tenants = sqliteTable('tenants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull(),                    // subdomain, e.g. "brads-cards"
  name: text('name').notNull(),                    // shop display name
  status: text('status').notNull().default('trialing'),
  // 'trialing' | 'active' | 'past_due' | 'paused' | 'suspended' | 'cancelled'
  plan: text('plan').notNull().default('growth'),  // 'starter' | 'growth' | 'pro'
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  tursoDbName: text('turso_db_name'),              // null for local file: DBs
  dbUrl: text('db_url').notNull(),                 // libsql://… or file:… (dev)
  region: text('region').notNull().default('fra'), // EU residency for UK GDPR
  setupToken: text('setup_token'),
  setupCompletedAt: integer('setup_completed_at'), // epoch seconds
  entitlementOverrides: text('entitlement_overrides'), // JSON, founding-shop deals
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('tenants_slug_unique').on(t.slug)])

export const stripeEvents = sqliteTable('stripe_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  stripeEventId: text('stripe_event_id').notNull(),
  type: text('type').notNull(),
  processedAt: integer('processed_at').notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('stripe_events_event_id_unique').on(t.stripeEventId)])

export const tenantSyncState = sqliteTable('tenant_sync_state', {
  tenantId: integer('tenant_id').primaryKey().references(() => tenants.id),
  lastPriceSyncAt: integer('last_price_sync_at'),
  lastCatalogueSyncAt: integer('last_catalogue_sync_at'),
  lastBackupAt: integer('last_backup_at'),
})

export const platformAudit = sqliteTable('platform_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),          // 'platform_admin' | 'system' | 'stripe'
  tenantId: integer('tenant_id'),
  action: text('action').notNull(),        // e.g. 'impersonate', 'provision', 'suspend'
  detail: text('detail'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export type Tenant = typeof tenants.$inferSelect
```

**Check the exact index syntax against `lib/db/schema.ts` before writing** — mirror whatever form (array vs object callback) the current drizzle-orm version uses there.

- [ ] **Step 4: Create `lib/platform/db.ts`**

```ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'

// Lazy: importing this module must never dial the registry (single-tenant
// deployments have no PLATFORM_DATABASE_URL at all).
let _pdb: ReturnType<typeof make> | null = null

function make(url: string, authToken?: string) {
  return drizzle(createClient({ url, authToken }), { schema })
}

export function getPlatformDb(): PlatformDb {
  if (!_pdb) {
    const url = process.env.PLATFORM_DATABASE_URL
    if (!url) throw new Error('PLATFORM_DATABASE_URL is not set (required when TENANCY_MODE=multi)')
    _pdb = make(url, process.env.PLATFORM_AUTH_TOKEN)
  }
  return _pdb
}

export type PlatformDb = ReturnType<typeof make>
```

- [ ] **Step 5: Create `drizzle-platform.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

export default defineConfig({
  schema: './lib/platform/schema.ts',
  out: './lib/platform/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.PLATFORM_DATABASE_URL!,
    authToken: process.env.PLATFORM_AUTH_TOKEN!,
  },
})
```

- [ ] **Step 6: Generate the registry migration**

Run: `npx drizzle-kit generate --config drizzle-platform.config.ts`
Expected: creates `lib/platform/migrations/0000_*.sql` + `meta/_journal.json`. (Generation doesn't need the env vars; only `migrate` does.)

- [ ] **Step 7: Create `lib/platform/test-helpers.ts`**

Mirror `lib/db/test-helpers.ts` (file-backed temp DBs — see that file's comment for why `:memory:` can't be used):

```ts
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomBytes } from 'node:crypto'
import * as schema from './schema'
import type { PlatformDb } from './db'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'platform', 'migrations')
const tempFiles: string[] = []

export async function applyPlatformMigrations(client: Client): Promise<void> {
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

process.on('exit', () => {
  for (const filePath of tempFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(filePath + suffix) } catch { /* ignore */ }
    }
  }
})

export async function createTestPlatformDb(): Promise<PlatformDb> {
  const dbPath = join(tmpdir(), `test-platform-${randomBytes(8).toString('hex')}.db`)
  tempFiles.push(dbPath)
  const client = createClient({ url: `file:${dbPath}` })
  await applyPlatformMigrations(client)
  return drizzle(client, { schema })
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -B1 -A5 "registry\|idempotency"`
Expected: 3 PASS

- [ ] **Step 9: Commit**

```bash
git add lib/platform drizzle-platform.config.ts
git commit -m "feat: platform registry DB (tenants, stripe events, sync state, audit)"
```

---

### Task 5: Tenant lookup + host parsing

**Files:**
- Create: `lib/platform/tenants.ts`
- Create: `lib/platform/tenants.test.ts`

**Interfaces:**
- Consumes: `getPlatformDb`, `tenants`, `Tenant` from Task 4.
- Produces:
  - `parseTenantSlug(host: string, baseHost: string): string | null` — pure
  - `RESERVED_SLUGS: readonly string[]`
  - `getTenantBySlug(slug: string, opts?: { db?: PlatformDb; ttlMs?: number; now?: number }): Promise<Tenant | null>` — 60s in-process cache
  - `clearTenantCache(): void`

- [ ] **Step 1: Write the failing tests**

Create `lib/platform/tenants.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { parseTenantSlug, getTenantBySlug, clearTenantCache } from './tenants'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { eq } from 'drizzle-orm'

const BASE = 'example-brand.co.uk'

test('parseTenantSlug extracts the shop subdomain', () => {
  assert.equal(parseTenantSlug('brads-cards.example-brand.co.uk', BASE), 'brads-cards')
  assert.equal(parseTenantSlug('BRADS-CARDS.Example-Brand.CO.UK', BASE), 'brads-cards')
  assert.equal(parseTenantSlug('brads-cards.example-brand.co.uk:3000', BASE), 'brads-cards')
})

test('parseTenantSlug returns null for apex, reserved, nested, and foreign hosts', () => {
  assert.equal(parseTenantSlug('example-brand.co.uk', BASE), null)          // apex
  assert.equal(parseTenantSlug('www.example-brand.co.uk', BASE), null)      // reserved
  assert.equal(parseTenantSlug('admin.example-brand.co.uk', BASE), null)    // reserved
  assert.equal(parseTenantSlug('a.b.example-brand.co.uk', BASE), null)      // nested
  assert.equal(parseTenantSlug('evil.com', BASE), null)                     // foreign
  assert.equal(parseTenantSlug('example-brand.co.uk.evil.com', BASE), null) // suffix trick
})

test('getTenantBySlug caches for the TTL', async () => {
  clearTenantCache()
  const pdb = await createTestPlatformDb()
  await pdb.insert(tenants).values({ slug: 'shop-a', name: 'Shop A', dbUrl: 'file:/tmp/a.db' })

  const first = await getTenantBySlug('shop-a', { db: pdb, now: 1000 })
  assert.equal(first!.name, 'Shop A')

  // Change the row behind the cache's back; cached value should be served…
  await pdb.update(tenants).set({ name: 'Renamed' }).where(eq(tenants.slug, 'shop-a'))
  const cached = await getTenantBySlug('shop-a', { db: pdb, now: 1000 + 59_000 })
  assert.equal(cached!.name, 'Shop A')

  // …until the TTL lapses.
  const fresh = await getTenantBySlug('shop-a', { db: pdb, now: 1000 + 61_000 })
  assert.equal(fresh!.name, 'Renamed')
})

test('getTenantBySlug returns null for unknown slugs (and caches the miss)', async () => {
  clearTenantCache()
  const pdb = await createTestPlatformDb()
  assert.equal(await getTenantBySlug('nope', { db: pdb, now: 0 }), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A5 parseTenantSlug`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/platform/tenants.ts`**

```ts
import { eq } from 'drizzle-orm'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, type Tenant } from './schema'

// Hosts that are never shop tenants.
export const RESERVED_SLUGS = ['www', 'admin', 'api', 'app'] as const

// "brads-cards.example-brand.co.uk" → "brads-cards"; anything that isn't
// exactly one non-reserved label in front of the base host → null.
export function parseTenantSlug(host: string, baseHost: string): string | null {
  const clean = host.toLowerCase().split(':')[0]
  const base = baseHost.toLowerCase()
  if (!clean.endsWith(`.${base}`)) return null
  const prefix = clean.slice(0, clean.length - base.length - 1)
  if (!prefix || prefix.includes('.')) return null
  if ((RESERVED_SLUGS as readonly string[]).includes(prefix)) return null
  return prefix
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { tenant: Tenant | null; at: number }>()

export function clearTenantCache(): void {
  cache.clear()
}

export async function getTenantBySlug(
  slug: string,
  opts: { db?: PlatformDb; ttlMs?: number; now?: number } = {},
): Promise<Tenant | null> {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const hit = cache.get(slug)
  if (hit && now - hit.at < ttl) return hit.tenant
  const pdb = opts.db ?? getPlatformDb()
  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1)
  cache.set(slug, { tenant: tenant ?? null, at: now })
  return tenant ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -B1 -A5 "parseTenantSlug\|caches"`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/platform/tenants.ts lib/platform/tenants.test.ts
git commit -m "feat: tenant host parsing + cached registry lookup"
```

---

### Task 6: Tenant-scoped Db — rework `lib/db/index.ts`

**Files:**
- Modify: `lib/db/index.ts` (full replacement below)
- Create: `lib/db/tenant-db.test.ts`
- Modify: `app/api/health/route.ts` (registry-aware in multi mode)

**Interfaces:**
- Consumes: `Tenant` shape (only `id`, `dbUrl`) via headers set by Task 8's proxy.
- Produces (all later tasks depend on these exact names):
  - `export type Db` — unchanged shape (drizzle client over the tenant schema)
  - `export const db: Db` — the singleton; **throws on first use when `TENANCY_MODE=multi`** (fail-loud: no code path may silently fall back to a shared DB in multi mode)
  - `export function isMultiTenant(): boolean`
  - `export function getTenantDbFor(tenantId: string, dbUrl: string): Db` — cached per-tenant client (exported for the cron fan-out + scripts)
  - `export async function getTenantDb(): Promise<Db>` — single mode: the singleton; multi mode: reads `x-tenant-id`/`x-tenant-db-url` request headers (dynamic-imports `next/headers` so plain-node scripts can import `lib/db` safely)

- [ ] **Step 1: Write the failing tests**

Create `lib/db/tenant-db.test.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { sql } from 'drizzle-orm'
import { db, getTenantDb, getTenantDbFor, isMultiTenant } from './index'

const originalMode = process.env.TENANCY_MODE
afterEach(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = originalMode
})

test('single mode: getTenantDb returns the working singleton', async () => {
  delete process.env.TENANCY_MODE
  assert.equal(isMultiTenant(), false)
  const d = await getTenantDb()
  await d.run(sql`select 1`) // env :memory: from npm test
})

test('multi mode: touching the singleton throws loudly', async () => {
  process.env.TENANCY_MODE = 'multi'
  assert.equal(isMultiTenant(), true)
  await assert.rejects(async () => db.run(sql`select 1`), /TENANCY_MODE=multi/)
})

test('getTenantDbFor returns isolated, cached clients', async () => {
  const { createTestDb } = await import('./test-helpers')
  // createTestDb gives us two real migrated DBs; getTenantDbFor must return
  // distinct clients for distinct URLs and the same instance for repeat calls.
  const a = getTenantDbFor('1', 'file:/tmp/tenant-a-test.db')
  const b = getTenantDbFor('2', 'file:/tmp/tenant-b-test.db')
  const a2 = getTenantDbFor('1', 'file:/tmp/tenant-a-test.db')
  assert.notEqual(a, b)
  assert.equal(a, a2)
  void createTestDb
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A5 "tenant-db\|singleton"`
Expected: FAIL — `getTenantDb` etc. not exported

- [ ] **Step 3: Replace `lib/db/index.ts`**

```ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { DomainError } from '@/lib/domain/errors'
import * as schema from './schema'

function makeDb(url: string, authToken?: string) {
  return drizzle(createClient({ url, authToken }), { schema })
}

export type Db = ReturnType<typeof makeDb>

export function isMultiTenant(): boolean {
  return process.env.TENANCY_MODE === 'multi'
}

// --- single-tenant singleton (today's behaviour) ---------------------------
// Lazy so that importing this module never dials a database, and so multi-
// tenant deployments (no TURSO_DATABASE_URL) fail loudly — not silently
// against a shared DB — if any code path forgets to pass a tenant Db.
let _singleton: Db | null = null
function singleton(): Db {
  if (isMultiTenant()) {
    throw new Error(
      'Singleton db is unavailable in TENANCY_MODE=multi — resolve a tenant Db via getTenantDb() and pass it explicitly',
    )
  }
  if (!_singleton) {
    _singleton = makeDb(process.env.TURSO_DATABASE_URL!, process.env.TURSO_AUTH_TOKEN)
  }
  return _singleton
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = singleton()
    const value = Reflect.get(real as object, prop)
    return typeof value === 'function' ? value.bind(real) : value
  },
})

// --- multi-tenant clients ---------------------------------------------------
const tenantDbs = new Map<string, Db>()

export function getTenantDbFor(tenantId: string, dbUrl: string): Db {
  const existing = tenantDbs.get(tenantId)
  if (existing) return existing
  const authToken = dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined
  const client = makeDb(dbUrl, authToken)
  tenantDbs.set(tenantId, client)
  return client
}

// Request-scoped tenant Db. In single mode this is the singleton; in multi
// mode the proxy (proxy.ts) has already resolved the tenant and injected
// trusted headers. next/headers is imported dynamically so scripts run under
// plain tsx can import this module.
export async function getTenantDb(): Promise<Db> {
  if (!isMultiTenant()) return singleton()
  const { headers } = await import('next/headers')
  const h = await headers()
  const tenantId = h.get('x-tenant-id')
  const dbUrl = h.get('x-tenant-db-url')
  if (!tenantId || !dbUrl) {
    throw new DomainError('UNAUTHORIZED', 'No tenant context for this request')
  }
  return getTenantDbFor(tenantId, dbUrl)
}
```

**Check first:** confirm `DomainError` in `lib/domain/errors.ts` has an `'UNAUTHORIZED'` code (lib/auth.ts already throws it) and that `lib/domain/errors.ts` does not import `lib/db` (it must not — that would be a cycle). If it does, throw a plain `Error` here instead and note it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: new tests PASS **and the entire existing suite stays green** (the Proxy singleton must be transparent — `db.transaction(...)`, `db.select()` etc. all still work; the domain tests exercise this heavily).

- [ ] **Step 5: Make `/api/health` registry-aware**

Replace the body of `app/api/health/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'

// Unauthenticated liveness check. Single mode pings the shop DB; multi mode
// pings the registry (tenant DBs are checked per-tenant by the backup cron).
export async function GET() {
  try {
    if (isMultiTenant()) {
      await getPlatformDb().run(sql`select 1`)
    } else {
      await db.run(sql`select 1`)
    }
    return NextResponse.json({ ok: true, db: true })
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 })
  }
}
```

- [ ] **Step 6: Full suite + lint**

Run: `npm test && npm run lint`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add lib/db/index.ts lib/db/tenant-db.test.ts app/api/health/route.ts
git commit -m "feat: tenant-scoped Db resolution with fail-loud singleton in multi mode"
```

---

### Task 7: Per-tenant owner password (settings column + migration)

**Files:**
- Modify: `lib/db/schema.ts` (settings table — one new column)
- Create (generated): `lib/db/migrations/0015_*.sql`
- Modify: `lib/domain/staff.ts` (two small helpers)
- Modify: `lib/settings.ts` (ensure the new column is NOT exposed)
- Modify: `app/api/auth/owner/route.ts` (hash lookup order)
- Test: extend `lib/domain/staff.test.ts`

**Interfaces:**
- Produces: `getOwnerPasswordHash(dbc?: Db): Promise<string | null>` and `setOwnerPasswordHash(hash: string, dbc?: Db): Promise<void>` in `lib/domain/staff.ts`. Phase 2's `/setup` flow calls the setter; owner login calls the getter.

- [ ] **Step 1: Write the failing test**

Append to `lib/domain/staff.test.ts` (match the file's existing setup idiom — it uses `createTestDb()`/`seedBase()` from `lib/db/test-helpers`):

```ts
test('owner password hash: unset by default, settable, retrievable', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  assert.equal(await getOwnerPasswordHash(dbc), null)
  await setOwnerPasswordHash('$2b$10$fakehash', dbc)
  assert.equal(await getOwnerPasswordHash(dbc), '$2b$10$fakehash')
})
```

(Add `getOwnerPasswordHash, setOwnerPasswordHash` to the file's import from `./staff`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B1 -A5 "owner password"`
Expected: FAIL — not exported

- [ ] **Step 3: Add the column to `lib/db/schema.ts` settings table**

Inside the existing `settings = sqliteTable('settings', {...})` block, after `shopName`:

```ts
  // Per-tenant owner password (bcrypt). Null = fall back to the
  // OWNER_PASSWORD_HASH env var (single-tenant installs).
  ownerPasswordHash: text('owner_password_hash'),
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: `lib/db/migrations/0015_*.sql` containing `ALTER TABLE settings ADD owner_password_hash text;`

**Do not run `drizzle-kit migrate`** — the live dev DB migration is the user's step (deploy doesn't auto-migrate; see AGENTS.md). Tests apply migrations from the journal automatically.

- [ ] **Step 5: Implement the helpers in `lib/domain/staff.ts`**

```ts
export async function getOwnerPasswordHash(dbc: Db = db): Promise<string | null> {
  const [row] = await dbc.select({ hash: settings.ownerPasswordHash }).from(settings).limit(1)
  return row?.hash ?? null
}

export async function setOwnerPasswordHash(hash: string, dbc: Db = db): Promise<void> {
  await dbc.update(settings).set({ ownerPasswordHash: hash })
}
```

(Add `settings` to the file's schema imports if missing.)

- [ ] **Step 6: Keep the hash out of the settings API**

Open `lib/settings.ts`: `getSettings()` must not return `ownerPasswordHash`. If it selects specific columns, no change; if it maps the whole row, exclude the field explicitly and add this test to `lib/settings.test.ts` (create the test file if it doesn't exist, using `createTestDb`+`seedBase`):

```ts
test('getSettings never exposes ownerPasswordHash', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const s = await getSettings(dbc)
  assert.ok(!('ownerPasswordHash' in s))
})
```

- [ ] **Step 7: Owner login prefers the tenant hash**

In `app/api/auth/owner/route.ts`, replace the `const hash = process.env.OWNER_PASSWORD_HASH` line:

```ts
import { db } from '@/lib/db'
import { getOwnerPasswordHash } from '@/lib/domain/staff'
// …inside POST, after parseBody:
  const hash = (await getOwnerPasswordHash(db)) ?? process.env.OWNER_PASSWORD_HASH
```

(Task 9 revisits this file to thread the tenant db + session tenantId — using the singleton here is correct for now and keeps this task shippable alone.)

- [ ] **Step 8: Run the suite**

Run: `npm test && npm run lint`
Expected: pass, including the new tests.

- [ ] **Step 9: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations lib/domain/staff.ts lib/domain/staff.test.ts lib/settings.ts lib/settings.test.ts app/api/auth/owner/route.ts
git commit -m "feat: per-tenant owner password hash in settings (env fallback preserved)"
```

---

### Task 8: Proxy tenant resolution + session tenant binding

**Files:**
- Modify: `proxy.ts` (full replacement below)
- Create: `lib/platform/routing.ts` + `lib/platform/routing.test.ts` (pure decision logic)
- Modify: `lib/auth.ts` (SessionData.tenantId + mismatch invalidation)
- Create: `app/suspended/page.tsx`

**Interfaces:**
- Consumes: `parseTenantSlug`, `getTenantBySlug` (Task 5); `Tenant` (Task 4).
- Produces:
  - Trusted request headers on tenant requests: `x-tenant-id` (string of tenants.id), `x-tenant-db-url`, `x-tenant-status`
  - `decideTenantRouting(input: { slug: string | null; tenant: Pick<Tenant,'id'|'dbUrl'|'status'> | null }): { kind: 'not-tenant' } | { kind: 'unknown' } | { kind: 'blocked' } | { kind: 'serve'; headers: Record<string,string> }`
  - `SessionData.tenantId?: string`; `getSession(currentTenantId?: string)` destroys sessions whose tenantId mismatches

- [ ] **Step 1: Write the failing routing tests**

Create `lib/platform/routing.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { decideTenantRouting } from './routing'

const tenant = (status: string) => ({ id: 7, dbUrl: 'file:/tmp/t.db', status })

test('no slug → not a tenant host', () => {
  assert.deepEqual(decideTenantRouting({ slug: null, tenant: null }), { kind: 'not-tenant' })
})

test('slug with no registry row → unknown', () => {
  assert.deepEqual(decideTenantRouting({ slug: 'ghost', tenant: null }), { kind: 'unknown' })
})

test('suspended/cancelled/paused tenants are blocked', () => {
  for (const s of ['suspended', 'cancelled', 'paused']) {
    assert.deepEqual(decideTenantRouting({ slug: 'x', tenant: tenant(s) }), { kind: 'blocked' })
  }
})

test('live tenants get trusted headers', () => {
  for (const s of ['trialing', 'active', 'past_due']) {
    const d = decideTenantRouting({ slug: 'x', tenant: tenant(s) })
    assert.deepEqual(d, {
      kind: 'serve',
      headers: { 'x-tenant-id': '7', 'x-tenant-db-url': 'file:/tmp/t.db', 'x-tenant-status': s },
    })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A5 routing`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/platform/routing.ts`**

```ts
import type { Tenant } from './schema'

const BLOCKED_STATUSES = new Set(['suspended', 'cancelled', 'paused'])

export type TenantRouting =
  | { kind: 'not-tenant' }
  | { kind: 'unknown' }
  | { kind: 'blocked' }
  | { kind: 'serve'; headers: Record<string, string> }

export function decideTenantRouting(input: {
  slug: string | null
  tenant: Pick<Tenant, 'id' | 'dbUrl' | 'status'> | null
}): TenantRouting {
  if (input.slug === null) return { kind: 'not-tenant' }
  if (!input.tenant) return { kind: 'unknown' }
  if (BLOCKED_STATUSES.has(input.tenant.status)) return { kind: 'blocked' }
  return {
    kind: 'serve',
    headers: {
      'x-tenant-id': String(input.tenant.id),
      'x-tenant-db-url': input.tenant.dbUrl,
      'x-tenant-status': input.tenant.status,
    },
  }
}
```

- [ ] **Step 4: Run routing tests to verify they pass**

Run: `npm test 2>&1 | grep -B1 -A5 routing`
Expected: 4 PASS

- [ ] **Step 5: Extend `lib/auth.ts`**

Add `tenantId` to the session and invalidate cross-tenant sessions:

```ts
export interface SessionData {
  isOwnerLoggedIn: boolean
  staffId?: number
  staffRole?: 'admin' | 'staff'
  staffName?: string
  tenantId?: string
}
```

Replace `getSession` with:

```ts
// currentTenantId: pass the resolved tenant on multi-tenant requests so a
// session minted for one shop can never act on another (defence in depth —
// cookies are already host-scoped per subdomain).
export async function getSession(currentTenantId?: string): Promise<IronSession<SessionData>> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
  if (currentTenantId && session.tenantId && session.tenantId !== currentTenantId) {
    session.destroy()
    return getIronSession<SessionData>(await cookies(), sessionOptions)
  }
  return session
}

// Resolve the current tenant id from proxy-injected headers (multi mode only).
export async function currentTenantId(): Promise<string | undefined> {
  if (process.env.TENANCY_MODE !== 'multi') return undefined
  const { headers } = await import('next/headers')
  return (await headers()).get('x-tenant-id') ?? undefined
}
```

- [ ] **Step 6: Replace `proxy.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/auth'
import { parseTenantSlug, getTenantBySlug } from '@/lib/platform/tenants'
import { decideTenantRouting } from '@/lib/platform/routing'

const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/cron/', '/api/health', '/suspended']

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Never trust inbound tenant headers — the proxy is their only writer.
  const requestHeaders = new Headers(req.headers)
  for (const h of ['x-tenant-id', 'x-tenant-db-url', 'x-tenant-status']) requestHeaders.delete(h)

  let resolvedTenantId: string | undefined

  if (process.env.TENANCY_MODE === 'multi') {
    const baseHost = process.env.PLATFORM_BASE_HOST
    if (!baseHost) return new NextResponse('Platform misconfigured', { status: 500 })
    const slug = parseTenantSlug(req.headers.get('host') ?? '', baseHost)
    const tenant = slug ? await getTenantBySlug(slug) : null
    const decision = decideTenantRouting({ slug, tenant })

    if (decision.kind === 'not-tenant') {
      // Apex/www/admin: no shop app here yet (marketing site is external;
      // admin arrives in Phase 3). Health stays reachable for monitors.
      if (pathname.startsWith('/api/health')) return NextResponse.next()
      return new NextResponse('Not found', { status: 404 })
    }
    if (decision.kind === 'unknown') return new NextResponse('Unknown shop', { status: 404 })
    if (decision.kind === 'blocked') {
      if (pathname.startsWith('/suspended') || pathname.startsWith('/api/health')) {
        return NextResponse.next()
      }
      return NextResponse.rewrite(new URL('/suspended', req.url))
    }
    for (const [k, v] of Object.entries(decision.headers)) requestHeaders.set(k, v)
    resolvedTenantId = decision.headers['x-tenant-id']
  }

  const pass = () => NextResponse.next({ request: { headers: requestHeaders } })

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return pass()

  const res = pass()
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  const crossTenant =
    resolvedTenantId !== undefined && session.tenantId !== undefined && session.tenantId !== resolvedTenantId
  if (!session.isOwnerLoggedIn || crossTenant) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

**Runtime note:** this imports `@libsql/client` into the proxy. This Next version runs proxy in the Node runtime on Vercel (Fluid), so the default client is fine. If the build complains about edge compatibility, switch `lib/platform/db.ts` to `@libsql/client/web` (HTTP-only driver — works for `libsql://` URLs; local `file:` URLs are only used by tests/scripts which import the standard client via test-helpers).

- [ ] **Step 7: Create `app/suspended/page.tsx`**

```tsx
import { BRAND } from '@/lib/brand'

export default function SuspendedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">This shop is currently unavailable</h1>
        <p className="text-muted-foreground">
          The subscription for this shop isn't active. If you're the shop owner,
          check your billing details or contact {BRAND.supportEmail}.
        </p>
      </div>
    </main>
  )
}
```

- [ ] **Step 8: Set `tenantId` at login**

In `app/api/auth/owner/route.ts` and `app/api/auth/staff-pin/route.ts`, where the session is saved after successful auth, add:

```ts
import { currentTenantId } from '@/lib/auth'
// …after successful credential check, before session.save():
  session.tenantId = await currentTenantId()
```

(In single mode `currentTenantId()` is `undefined` — sessions look exactly like today's.)

- [ ] **Step 9: Full suite + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: all pass. The build catches any client/server boundary breakage from the proxy imports.

- [ ] **Step 10: Commit**

```bash
git add proxy.ts lib/auth.ts lib/platform/routing.ts lib/platform/routing.test.ts app/suspended app/api/auth
git commit -m "feat: subdomain tenant resolution in proxy with status gates and tenant-bound sessions"
```

---

### Task 9: Route sweep — every handler passes an explicit tenant Db

**Files (all 33 route files under `app/api/`), plus:**
- Modify: `lib/credit.ts` (add `dbc: Db = db` param to `getCustomerBalance`)
- Modify: `lib/settings.ts` (add `dbc: Db = db` param to `updateSettings`)
- Create: `tests/tenancy-guard.test.ts`

**Interfaces:**
- Consumes: `getTenantDb()` (Task 6).
- Produces: the invariant *no route touches the singleton* — enforced by a guard test that future tasks (and Phases 2–3) inherit.

**The recipe, applied to every file in the checklist below:**

1. Remove `import { db } from '@/lib/db'` (if present); add `import { getTenantDb } from '@/lib/db'`.
2. First line of **each** exported handler (`GET`/`POST`/`PATCH`/`DELETE`): `const db = await getTenantDb()`. Shadowing the old import name means every existing inline `db.select()...` usage keeps working unchanged.
3. Pass `db` explicitly to **every** call of a `lib/domain/*`, `lib/settings`, `lib/credit`, or `lib/prices/sync` function in the handler — these all have trailing `dbc: Db = db` defaults that silently hit the singleton (which **throws** in multi mode, so any missed call site surfaces in the Task 12 integration test, loudly). Check each function's signature for where the `dbc` param sits (e.g. `assertNotLocked('owner', db)`, `getSettings(db)`, `createSale(input, db)`).
4. Auth: handlers currently calling `getSession()` change to `getSession(await currentTenantId())` (import `currentTenantId` from `@/lib/auth`).

- [ ] **Step 1: Write the failing guard test**

Create `tests/tenancy-guard.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globSync } from 'node:fs'

// Routes must resolve the tenant Db per request; importing the singleton
// binds them to single-tenant mode and breaks isolation in multi mode.
test('no API route imports the db singleton', () => {
  const files = globSync('app/api/**/route.ts', { cwd: process.cwd() })
  assert.ok(files.length >= 30, `expected to find route files, got ${files.length}`)
  const offenders = files.filter(f => {
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    return /import\s*{[^}]*\bdb\b[^}]*}\s*from\s*'@\/lib\/db'/.test(src)
  })
  assert.deepEqual(offenders, [])
})
```

(`globSync` is available from `node:fs` on Node ≥22; if the runtime lacks it, walk directories with `readdirSync` recursion instead — keep zero new dependencies.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -B1 -A8 "singleton"`
Expected: FAIL listing the 19 offender files.

- [ ] **Step 3: Add the missing `Db` params to the two stragglers**

`lib/credit.ts`:

```ts
export async function getCustomerBalance(customerId: number, dbc: Db = db): Promise<number> {
```

(thread `dbc` through its internal queries; add the `Db`/`db` imports to match `lib/settings.ts`'s pattern).

`lib/settings.ts`:

```ts
export async function updateSettings(patch: Partial<AppSettings>, dbc: Db = db): Promise<AppSettings> {
```

(same threading). Run `npm test` — existing tests must stay green (defaults preserve behaviour).

- [ ] **Step 4: Sweep the route files (the checklist)**

Apply the recipe to each; tick as you go. Worked example first — `app/api/sales/route.ts`:

```ts
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
// … (drop `db` from the '@/lib/db' import)

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  const session = requireStaff(await getSession(await currentTenantId()))
  // …
  const result = await createSale({ ...input, staffId: session.staffId }, db)
```

Files (every handler in each):

- [ ] `app/api/auth/owner/route.ts` — also: `assertNotLocked('owner', db)`, `recordFailedAttempt('owner', db)`, `clearLockout('owner', db)`, `clearLockout('staff-pin', db)`, `getOwnerPasswordHash(db)`
- [ ] `app/api/auth/staff-pin/route.ts` — lockout calls + the inline `db.select().from(staff)`
- [ ] `app/api/buys/route.ts`, `app/api/buys/[id]/route.ts`
- [ ] `app/api/cards/route.ts`? — **does not exist**; skip. `app/api/cards/[id]/route.ts`, `app/api/cards/browse/route.ts`, `app/api/cards/browse-by-name/route.ts`, `app/api/cards/names/route.ts`, `app/api/cards/search/route.ts`, `app/api/cards/sets/route.ts`
- [ ] `app/api/cron/sync-prices/route.ts` — special: see Step 5
- [ ] `app/api/customers/route.ts`, `app/api/customers/[id]/route.ts`, `app/api/customers/[id]/credit/route.ts` (also `getCustomerBalance(id, db)`)
- [ ] `app/api/inventory/route.ts`, `app/api/inventory/[id]/route.ts`, `app/api/inventory/[id]/qr/route.ts`, `app/api/inventory/export/route.ts`, `app/api/inventory/import/route.ts`
- [ ] `app/api/labels/batch/route.ts`
- [ ] `app/api/prices/cardmarket/route.ts`, `app/api/prices/search/route.ts`
- [ ] `app/api/refunds/route.ts`
- [ ] `app/api/reports/cash-up/route.ts`, `app/api/reports/margin-stock-book/route.ts`, `app/api/reports/sales/route.ts`, `app/api/reports/sales/export/route.ts`
- [ ] `app/api/sales/route.ts`, `app/api/sales/[id]/route.ts`, `app/api/sales/[id]/items/route.ts`, `app/api/sales/history/route.ts`
- [ ] `app/api/settings/route.ts` — `getSettings(db)`, `updateSettings(patch, db)`
- [ ] `app/api/staff/route.ts`, `app/api/staff/[id]/route.ts`
- [ ] `app/api/wants/route.ts`

Also grep server components for singleton usage — `grep -rn "from '@/lib/db'" app/\(app\) components` — expected: none (pages fetch via API routes). If any turn up, apply the same recipe (`getTenantDb()` in the server component).

- [ ] **Step 5: Cron fan-out**

Replace the body of `app/api/cron/sync-prices/route.ts` after the auth check:

```ts
import { getTenantDb, getTenantDbFor, isMultiTenant, type Db } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenants } from '@/lib/platform/schema'
import { inArray } from 'drizzle-orm'

async function syncOne(db: Db) {
  const settings = await getSettings(db)
  const sweep = await sweepTcgplayerCatalogue(settings, db)
  const cardmarket = await syncInStockCardmarket(settings, db)
  await pruneOldHistory(db)
  return { sweep, cardmarket }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) {
    return NextResponse.json(await syncOne(await getTenantDb()))
  }
  // Simple sequential fan-out — fine for the first ~10 shops; the cursor-based
  // staggering lands in Phase 3 (spec §3.7).
  const live = await getPlatformDb().select().from(tenants)
    .where(inArray(tenants.status, ['trialing', 'active', 'past_due']))
  const results: Record<string, unknown> = {}
  for (const t of live) {
    try {
      results[t.slug] = await syncOne(getTenantDbFor(String(t.id), t.dbUrl))
    } catch (e) {
      results[t.slug] = { error: e instanceof Error ? e.message : 'sync failed' }
    }
  }
  return NextResponse.json(results)
}
```

**Check the real signatures** of `sweepTcgplayerCatalogue`/`syncInStockCardmarket` in `lib/prices/sync.ts` before writing — the `dbc` param position must match (they already accept one; `pruneOldHistory(dbc: Db = db)` is confirmed).

- [ ] **Step 6: Run the guard test + full suite**

Run: `npm test && npm run lint && npm run build`
Expected: guard test PASSES (zero offenders), entire suite green, build clean.

- [ ] **Step 7: Commit**

```bash
git add app/api lib/credit.ts lib/settings.ts tests/tenancy-guard.test.ts
git commit -m "refactor: all routes resolve a tenant Db per request (guard test enforces)"
```

---

### Task 10: Local tenant provisioning script

**Files:**
- Create: `scripts/create-tenant.ts`
- Modify: `lib/db/test-helpers.ts` — export nothing new; `applyMigrations` is already exported and reused.

**Interfaces:**
- Consumes: `applyMigrations` (lib/db/test-helpers), `getPlatformDb`-compatible client, `tenants` schema.
- Produces: CLI `npx tsx scripts/create-tenant.ts --slug <slug> --name <name> --db-url <url>` → migrated tenant DB + registry row. (Phase 2's Stripe-webhook provisioning supersedes this for cloud; this stays the dev/adoption tool — an existing Wizard-of-Oz DB is adopted by passing its URL.)

- [ ] **Step 1: Write the script**

```ts
// Create (or adopt) a tenant: apply tenant migrations to the target DB, seed
// the settings row, and register it in the platform registry.
//
// Usage:
//   PLATFORM_DATABASE_URL=file:./platform.db npx tsx scripts/create-tenant.ts \
//     --slug brads-cards --name "Brad's Cards" --db-url file:./tenant-brads.db
//
// For cloud DBs create the database first (see the Wizard-of-Oz runbook), then
// pass its libsql:// URL here with TURSO_GROUP_AUTH_TOKEN set.
import { parseArgs } from 'node:util'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../lib/db/test-helpers'
import { applyPlatformMigrations } from '../lib/platform/test-helpers'
import * as tenantSchema from '../lib/db/schema'
import * as platformSchema from '../lib/platform/schema'

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'db-url': { type: 'string' },
  },
})

async function main() {
  const { slug, name } = values
  const dbUrl = values['db-url']
  if (!slug || !name || !dbUrl) {
    console.error('Required: --slug --name --db-url')
    process.exit(1)
  }
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    console.error('Slug must be lowercase letters/digits/hyphens, 3–40 chars')
    process.exit(1)
  }

  const platformUrl = process.env.PLATFORM_DATABASE_URL
  if (!platformUrl) {
    console.error('PLATFORM_DATABASE_URL is required')
    process.exit(1)
  }

  // 1. Tenant DB: migrate + seed settings (idempotent on re-run).
  const tenantClient = createClient({
    url: dbUrl,
    authToken: dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined,
  })
  await applyMigrations(tenantClient)
  const tdb = drizzle(tenantClient, { schema: tenantSchema })
  const existingSettings = await tdb.select().from(tenantSchema.settings).limit(1)
  if (existingSettings.length === 0) {
    await tdb.insert(tenantSchema.settings).values({ id: 1, shopName: name })
  }

  // 2. Registry: migrate (idempotent-ish for file DBs) + upsert tenant row.
  const platformClient = createClient({ url: platformUrl, authToken: process.env.PLATFORM_AUTH_TOKEN })
  try {
    await applyPlatformMigrations(platformClient)
  } catch {
    // Already migrated — fine.
  }
  const pdb = drizzle(platformClient, { schema: platformSchema })
  const [existing] = await pdb.select().from(platformSchema.tenants)
    .where(eq(platformSchema.tenants.slug, slug))
  if (existing) {
    console.error(`Tenant '${slug}' already exists (id ${existing.id})`)
    process.exit(1)
  }
  const [row] = await pdb.insert(platformSchema.tenants)
    .values({ slug, name, dbUrl }).returning()
  console.log(`Tenant '${slug}' registered with id ${row.id} → ${dbUrl}`)
  console.log(`Serve it locally: TENANCY_MODE=multi PLATFORM_BASE_HOST=localhost PLATFORM_DATABASE_URL=${platformUrl} npm run dev`)
  console.log(`Then visit http://${slug}.localhost:3000`)
}

main().catch(e => { console.error(e); process.exit(1) })
```

**Note:** migration re-application isn't tracked for `file:` DBs (the journal loop re-runs all statements). For adoption of *existing* migrated DBs this errors on duplicate tables — acceptable for a dev tool: catch and continue is already done for the platform DB; wrap the tenant `applyMigrations` in the same try/catch with a `--skip-migrations` escape hatch if it bites.

- [ ] **Step 2: Smoke-test the script locally**

```bash
cd /tmp && mkdir -p tenant-smoke && cd tenant-smoke
PLATFORM_DATABASE_URL=file:./platform.db npx tsx <repo>/scripts/create-tenant.ts \
  --slug shop-a --name "Shop A" --db-url file:./tenant-a.db
PLATFORM_DATABASE_URL=file:./platform.db npx tsx <repo>/scripts/create-tenant.ts \
  --slug shop-b --name "Shop B" --db-url file:./tenant-b.db
```

(Run from the repo root with relative paths adjusted — the point is: two runs, two DBs, two registry rows, second run of the same slug exits 1.)
Expected: both register; re-running shop-a errors with "already exists".

- [ ] **Step 3: Commit**

```bash
git add scripts/create-tenant.ts
git commit -m "feat: create-tenant script (local provisioning + Wizard-of-Oz adoption)"
```

---

### Task 11: Multi-tenant isolation integration test

**Files:**
- Create: `lib/platform/tenancy.integration.test.ts`

**Interfaces:**
- Consumes: everything above. This is the Phase-1 exit test from the spec: two tenants, one process, full isolation.

- [ ] **Step 1: Write the test**

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import { getTenantDbFor } from '../db/index'
import { createSale } from '../domain/sales'
import * as schema from '../db/schema'

// Phase-1 exit test (spec §Part 4): two tenant DBs served by one process,
// operations on one never touch the other, and the singleton is unreachable.

const originalMode = process.env.TENANCY_MODE
before(() => { process.env.TENANCY_MODE = 'multi' })
after(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = originalMode
})

test('sales in tenant A are invisible to tenant B', async () => {
  const dbA = await createTestDb()
  const dbB = await createTestDb()
  await seedBase(dbA)
  await seedBase(dbB)

  // Stock one copy of card 1 in each shop at different prices.
  await dbA.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 5, priceOverride: 500, costPrice: 200,
  })
  await dbB.insert(schema.inventoryItems).values({
    cardId: 1, condition: 'NM', quantity: 3, priceOverride: 900, costPrice: 400,
  })

  const [itemA] = await dbA.select().from(schema.inventoryItems)
  const saleA = await createSale({
    items: [{ inventoryItemId: itemA.id, quantity: 1 }],
    paymentMethod: 'cash',
    staffId: 1,
    expectedTotal: 500,
  }, dbA)
  assert.ok(saleA.saleId)

  // Tenant B: no sales, stock untouched.
  const salesB = await dbB.select().from(schema.sales)
  assert.equal(salesB.length, 0)
  const [itemB] = await dbB.select().from(schema.inventoryItems)
  assert.equal(itemB.quantity, 3)

  // Tenant A: stock decremented exactly once.
  const [itemA2] = await dbA.select().from(schema.inventoryItems)
    .where(eq(schema.inventoryItems.id, itemA.id))
  assert.equal(itemA2.quantity, 4)
})

test('getTenantDbFor keeps clients isolated under interleaved use', async () => {
  const a = getTenantDbFor('iso-a', 'file:/tmp/iso-a.db')
  const b = getTenantDbFor('iso-b', 'file:/tmp/iso-b.db')
  assert.notEqual(a, b)
})
```

**Adjust the `createSale` input and `inventoryItems` columns to the real shapes** — read `lib/domain/sales.ts` (`CreateSaleInput`) and `lib/db/schema.ts:28` first; the schema may name columns differently (e.g. `priceOverride` vs `price_override` mapping, required fields like `language`/`isFoil`). The *assertions* (isolation, quantities) are the contract; the fixture shape must match reality. `seedBase` seeds staff id 1 + card id 1 + settings (vatScheme default) — check whether `createSale` needs `expectedTotal` to include VAT under the default scheme and set the fixture price accordingly.

- [ ] **Step 2: Run it**

Run: `npm test 2>&1 | grep -B1 -A8 "invisible\|interleaved"`
Expected: PASS. If `createSale` throws on `expectedTotal`, print the server total from the error message and fix the fixture (the domain layer is the source of truth — never loosen the assertion).

- [ ] **Step 3: Full verification sweep**

Run: `npm test && npm run lint && npm run build && npm run test:e2e`
Expected: everything green. E2E runs in single mode (no env changes) and proves the escape hatch holds.

- [ ] **Step 4: Commit**

```bash
git add lib/platform/tenancy.integration.test.ts
git commit -m "test: multi-tenant isolation integration test (Phase 1 exit)"
```

---

### Task 12: Docs + spec status

**Files:**
- Modify: `AGENTS.md` (multi-tenancy section)
- Modify: `docs/superpowers/specs/2026-07-11-saas-platform-architecture.md` (status notes)

- [ ] **Step 1: Add a tenancy section to `AGENTS.md`**

After the "Architecture" section, add:

```markdown
## Multi-tenancy (platform layer)

- `TENANCY_MODE` unset = single-tenant (tests, e2e, Wizard-of-Oz deploys). `TENANCY_MODE=multi`
  enables the platform: `proxy.ts` resolves the tenant from the subdomain against the registry
  DB (`lib/platform/`, env `PLATFORM_DATABASE_URL`) and injects `x-tenant-*` headers.
- **Route handlers must call `const db = await getTenantDb()` and pass it to every domain/lib
  call** — never import the `db` singleton in a route (`tests/tenancy-guard.test.ts` enforces;
  the singleton throws in multi mode). Domain functions keep their `dbc: Db = db` defaults for tests.
- Registry migrations: `npx drizzle-kit generate --config drizzle-platform.config.ts`
  (separate journal in `lib/platform/migrations/`).
- New tenant locally: `scripts/create-tenant.ts`; per-shop single-tenant deploys:
  `docs/runbooks/wizard-of-oz-shop-deploy.md`.
```

- [ ] **Step 2: Mark Phase 0 + 1 done in the spec's Part 4** (change the two phase headings to `— DONE (date)` with one line noting deviations, if any).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-11-saas-platform-architecture.md
git commit -m "docs: multi-tenancy guide in AGENTS.md, spec status update"
```

---

## Not in this plan (later plans)

- **Phase 2** (own plan, written after this merges): Stripe Billing + webhooks, automated provisioning via the Turso Platform API + parent schema DBs, `/setup` owner flow (consumes Task 7's `setOwnerPasswordHash`), Resend emails, onboarding checklist, `lib/plan.ts` gating.
- **Phase 3** (own plan): platform admin dashboard + impersonation, backup cron, Sentry wiring, rate limiting, PostHog/Crisp, GDPR full-shop export, sync-cron cursor staggering.
- Turso parent-schema migration propagation (Phase 2, with cloud provisioning — local `file:` tenants use the journal loop).

## Execution notes

- Sequential tasks; each leaves the repo green (`npm test && npm run lint`). Tasks 8–9 are the delicate ones — build must pass, and Task 9's guard test is the safety net.
- Branch: `feat/platform-foundation` in an isolated worktree; PR to `main` at the end with `npm run test:e2e` evidence.
