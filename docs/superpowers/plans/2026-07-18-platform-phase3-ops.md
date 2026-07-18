# Platform Phase 3 — Platform Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-tenant platform operable by a 3-person team: admin dashboard with audited impersonation, cursor-staggered price-sync and backup crons, rate limits on public/auth endpoints, full-shop GDPR export, and env-gated Sentry/PostHog/Crisp — spec §3.4, §3.7, §3.9, §3.10 / Part 4 Phase 3.

**Architecture:** Everything lands behind the existing `TENANCY_MODE` seam: new admin host routing in `proxy.ts`, a shared due-cursor fan-out helper in `lib/platform/` driving two thin cron routes, a portable logical SQL dump module reused by backups and the zip export, and observability wired through this Next version's `instrumentation.ts` / `instrumentation-client.ts` files with no-op defaults when env vars are unset. One registry migration (`impersonation_grants`); zero tenant-schema changes.

**Tech Stack:** Next 16 App Router (proxy.ts, instrumentation files), Drizzle + libsql, iron-session, bcryptjs, `@sentry/nextjs` (already installed), new deps: `@vercel/blob`, `posthog-js`, `fflate`.

## Global Constraints

- **Parallel-session ownership split (from the user, 2026-07-18):** this branch owns `lib/platform/`, `app/api/platform/`, `proxy.ts`, new admin-dashboard pages, cron routes, and registry migrations. **Never touch `lib/db/schema.ts`, never generate tenant-DB migrations, never modify `lib/domain/`** (sync fan-out lives in `lib/prices/` + cron routes, so no domain edits are needed). Small additive edits to shared infra files (`lib/auth.ts` one optional field, `lib/api.ts` error seam, auth routes' rate-limit lines, `app/layout.tsx` one line, `app/(app)/settings/page.tsx` one line) are allowed but must stay one-to-three lines each and be listed in the PR body.
- All route handlers: `guarded()` + zod `parseBody()` for JSON bodies; tenant data access via `await getTenantDb()`; never import the `db` singleton in routes or server components (`tests/tenancy-guard.test.ts` enforces).
- Single-tenant mode (`TENANCY_MODE` unset) must behave exactly as today: new platform surfaces 404/no-op, crons stay green, `npm test` runs with `TURSO_DATABASE_URL=:memory:`, e2e untouched.
- Registry migrations only, via `npx drizzle-kit generate --config drizzle-platform.config.ts --name <name>`.
- Client components never value-import from `lib/domain/` or anything touching `lib/db` (libsql-in-browser breaks the dev server).
- Money rules are untouched (no money code in this phase); timestamps: registry columns are epoch **seconds** integers, tenant `created_at` columns are **TEXT** `datetime('now')` strings — do not mix them up (the overview probe returns strings).
- Tests: `node:test` + `assert`, colocated `*.test.ts`; registry tests use `createTestPlatformDb()` (`lib/platform/test-helpers.ts`), tenant-DB tests use `createTestDb()`/`seedBase()` (`lib/db/test-helpers.ts`).
- Commit after every task; `npm test` + `npm run lint` green before the PR.

**Env vars introduced (all optional; unset = feature off, documented in Task 13):** `PLATFORM_ADMIN_PASSWORD_HASH`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_CRISP_WEBSITE_ID`, `BLOB_READ_WRITE_TOKEN`, `BACKUP_RETENTION_DAYS`.

---

### Task 1: Registry schema — `impersonation_grants` + migration 0002

**Files:**
- Modify: `lib/platform/schema.ts` (append table + type export)
- Create: `lib/platform/migrations/0002_impersonation-grants.sql` (generated)
- Test: `lib/platform/schema.test.ts` (append)

**Interfaces:**
- Produces: `impersonationGrants` table — `{ id, tokenHash (unique), tenantId (FK tenants.id), expiresAt (epoch s), usedAt (epoch s | null), createdAt }`.

- [ ] **Step 1: Write the failing test** — append to `lib/platform/schema.test.ts`:

```ts
import { impersonationGrants } from './schema'

test('impersonation grants: token hashes are unique, used_at starts null', async () => {
  const pdb = await createTestPlatformDb()
  const [t] = await pdb.insert(tenants).values({ slug: 'imp', name: 'Imp', dbUrl: 'file:x.db' }).returning()
  const [g] = await pdb.insert(impersonationGrants)
    .values({ tokenHash: 'abc', tenantId: t.id, expiresAt: 1000 }).returning()
  assert.equal(g.usedAt, null)
  await assert.rejects(
    pdb.insert(impersonationGrants).values({ tokenHash: 'abc', tenantId: t.id, expiresAt: 2000 }),
  )
})
```

(Fold the new import into the existing `./schema` import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "impersonation grants"`
Expected: FAIL — `impersonationGrants` is not exported.

- [ ] **Step 3: Implement** — append to `lib/platform/schema.ts`:

```ts
// One-time impersonation grants (spec §3.4): the admin dashboard mints a
// short-lived single-use token; the shop-host consume endpoint burns it and
// mints the tenant session. Only the sha256 of the token is stored.
export const impersonationGrants = sqliteTable('impersonation_grants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull(),
  tenantId: integer('tenant_id').notNull().references(() => tenants.id),
  expiresAt: integer('expires_at').notNull(),      // epoch seconds
  usedAt: integer('used_at'),                      // set exactly once (single-use)
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('impersonation_grants_token_hash_unique').on(t.tokenHash)])
```

- [ ] **Step 4: Generate the registry migration**

Run: `npx drizzle-kit generate --config drizzle-platform.config.ts --name impersonation-grants`
Expected: `lib/platform/migrations/0002_impersonation-grants.sql` + updated `meta/`. Inspect the SQL: one `CREATE TABLE impersonation_grants` + one `CREATE UNIQUE INDEX`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep -B1 -A3 "impersonation grants"`
Expected: PASS (test helper replays the new migration).

- [ ] **Step 6: Commit**

```bash
git add lib/platform/schema.ts lib/platform/schema.test.ts lib/platform/migrations/
git commit -m "feat(platform): impersonation_grants registry table (migration 0002)"
```

---

### Task 2: Cursor fan-out helper — `lib/platform/fanout.ts`

The one piece both staggered crons share: pick tenants whose cursor field is stale, oldest first, run a job for each inside a time budget, advance the cursor even on failure (a permanently broken tenant must not wedge the queue head; Sentry + the cron's JSON response surface the error, and the tenant retries next day).

**Files:**
- Create: `lib/platform/fanout.ts`
- Test: `lib/platform/fanout.test.ts`

**Interfaces:**
- Consumes: `tenants`, `tenantSyncState` from `./schema`; `PlatformDb` from `./db`.
- Produces:

```ts
export const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const
export interface FanoutResult {
  due: number                                                  // tenants that were due this invocation
  processed: { slug: string; ok: boolean; error?: string }[]   // in processing order
  remaining: number                                            // due but not reached (budget)
}
export async function forEachDueTenant(
  opts: {
    pdb: PlatformDb
    field: 'lastPriceSyncAt' | 'lastBackupAt'
    dueAfterSeconds: number
    budgetMs: number
    nowMs?: () => number       // injectable clock (tests)
  },
  fn: (tenant: Tenant) => Promise<void>,
): Promise<FanoutResult>
```

- [ ] **Step 1: Write the failing test** — `lib/platform/fanout.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestPlatformDb } from './test-helpers'
import { tenants, tenantSyncState } from './schema'
import { forEachDueTenant } from './fanout'

const HOUR = 3600

async function seedTenant(pdb: Awaited<ReturnType<typeof createTestPlatformDb>>,
  slug: string, status: string, lastPriceSyncAt: number | null) {
  const [t] = await pdb.insert(tenants).values({ slug, name: slug, dbUrl: `file:${slug}.db`, status }).returning()
  if (lastPriceSyncAt !== null) {
    await pdb.insert(tenantSyncState).values({ tenantId: t.id, lastPriceSyncAt })
  }
  return t
}

test('processes due tenants oldest-first, never-synced first of all, and advances the cursor', async () => {
  const pdb = await createTestPlatformDb()
  const nowS = 100 * HOUR
  await seedTenant(pdb, 'fresh', 'active', nowS - 1 * HOUR)      // not due
  await seedTenant(pdb, 'oldest', 'active', nowS - 50 * HOUR)    // due, oldest timestamp
  await seedTenant(pdb, 'stale', 'active', nowS - 21 * HOUR)     // due
  await seedTenant(pdb, 'never', 'active', null)                 // no sync row at all → most urgent

  const ran: string[] = []
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => nowS * 1000 },
    async (t) => { ran.push(t.slug) },
  )
  assert.deepEqual(ran, ['never', 'oldest', 'stale'])
  assert.equal(result.due, 3)
  assert.equal(result.remaining, 0)
  assert.deepEqual(result.processed.map(p => p.ok), [true, true, true])

  // Cursor advanced for all three (including the row-less tenant via upsert).
  const states = await pdb.select().from(tenantSyncState)
  const bySlugId = new Map(states.map(s => [s.tenantId, s.lastPriceSyncAt]))
  const all = await pdb.select().from(tenants)
  for (const t of all.filter(t => t.slug !== 'fresh')) {
    assert.equal(bySlugId.get(t.id), nowS, `${t.slug} cursor`)
  }
  // Not-due tenant untouched.
  const fresh = all.find(t => t.slug === 'fresh')!
  assert.equal(bySlugId.get(fresh.id), nowS - 1 * HOUR)
})

test('skips suspended/cancelled/paused tenants', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'live', 'active', null)
  await seedTenant(pdb, 'dead', 'suspended', null)
  await seedTenant(pdb, 'gone', 'cancelled', null)
  await seedTenant(pdb, 'iced', 'paused', null)
  const ran: string[] = []
  await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 0 },
    async (t) => { ran.push(t.slug) },
  )
  assert.deepEqual(ran, ['live'])
})

test('stops when the budget is spent but always processes at least one', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'a', 'active', null)
  await seedTenant(pdb, 'b', 'active', null)
  await seedTenant(pdb, 'c', 'active', null)
  let clock = 0
  const ran: string[] = []
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 10_000, nowMs: () => clock },
    async (t) => { ran.push(t.slug); clock += 11_000 },   // each job overshoots the budget
  )
  assert.equal(ran.length, 1)
  assert.equal(result.remaining, 2)
})

test('a failing tenant is recorded, does not stop the loop, and its cursor still advances', async () => {
  const pdb = await createTestPlatformDb()
  await seedTenant(pdb, 'boom', 'active', null)
  await seedTenant(pdb, 'fine', 'active', 100)
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 200 * HOUR * 1000 },
    async (t) => { if (t.slug === 'boom') throw new Error('db unreachable') },
  )
  assert.deepEqual(result.processed, [
    { slug: 'boom', ok: false, error: 'db unreachable' },
    { slug: 'fine', ok: true },
  ])
  const states = await pdb.select().from(tenantSyncState)
  assert.equal(states.length, 2)
  for (const s of states) assert.equal(s.lastPriceSyncAt, 200 * HOUR)
})

test('lastBackupAt uses its own column', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seedTenant(pdb, 'bk', 'active', 500)   // price cursor fresh-ish, backup never
  await forEachDueTenant(
    { pdb, field: 'lastBackupAt', dueAfterSeconds: 20 * HOUR, budgetMs: 60_000, nowMs: () => 1000 * 1000 },
    async () => {},
  )
  const [s] = await pdb.select().from(tenantSyncState).where(eq(tenantSyncState.tenantId, t.id))
  assert.equal(s.lastBackupAt, 1000)
  assert.equal(s.lastPriceSyncAt, 500)   // untouched
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -c "fanout"`
Expected: FAIL — cannot find module `./fanout`.

- [ ] **Step 3: Implement** — `lib/platform/fanout.ts`:

```ts
import { inArray, sql } from 'drizzle-orm'
import type { PlatformDb } from './db'
import { tenants, tenantSyncState, type Tenant } from './schema'

// Cursor-staggered fan-out over live tenants (spec §3.7): each cron
// invocation processes the tenants whose cursor field is stale, oldest first,
// inside a time budget, then advances the cursor. Failures advance the cursor
// too — a permanently broken tenant DB must not wedge the queue head; the
// error is surfaced in the cron response (and Sentry) and retried next cycle.

export const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const

export interface FanoutResult {
  due: number
  processed: { slug: string; ok: boolean; error?: string }[]
  remaining: number
}

export async function forEachDueTenant(
  opts: {
    pdb: PlatformDb
    field: 'lastPriceSyncAt' | 'lastBackupAt'
    dueAfterSeconds: number
    budgetMs: number
    nowMs?: () => number
  },
  fn: (tenant: Tenant) => Promise<void>,
): Promise<FanoutResult> {
  const nowMs = opts.nowMs ?? Date.now
  const startedAt = nowMs()
  const nowS = Math.floor(startedAt / 1000)
  const cutoff = nowS - opts.dueAfterSeconds
  const col = opts.field === 'lastPriceSyncAt' ? tenantSyncState.lastPriceSyncAt : tenantSyncState.lastBackupAt

  const rows = await opts.pdb
    .select({ tenant: tenants, cursor: col })
    .from(tenants)
    .leftJoin(tenantSyncState, sql`${tenantSyncState.tenantId} = ${tenants.id}`)
    .where(inArray(tenants.status, [...LIVE_STATUSES]))
    .orderBy(sql`coalesce(${col}, 0) asc`)

  const due = rows.filter(r => r.cursor == null || r.cursor <= cutoff)
  const processed: FanoutResult['processed'] = []

  for (const { tenant } of due) {
    if (processed.length > 0 && nowMs() - startedAt >= opts.budgetMs) break
    try {
      await fn(tenant)
      processed.push({ slug: tenant.slug, ok: true })
    } catch (e) {
      processed.push({ slug: tenant.slug, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    const completedAtS = Math.floor(nowMs() / 1000)
    await opts.pdb.insert(tenantSyncState)
      .values({ tenantId: tenant.id, [opts.field]: completedAtS })
      .onConflictDoUpdate({ target: tenantSyncState.tenantId, set: { [opts.field]: completedAtS } })
  }

  return { due: due.length, processed, remaining: due.length - processed.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "pass|fail" | tail -3`
Expected: all fanout tests PASS, suite still green.

- [ ] **Step 5: Commit**

```bash
git add lib/platform/fanout.ts lib/platform/fanout.test.ts
git commit -m "feat(platform): cursor-staggered tenant fan-out helper"
```

---

### Task 3: Price-sync fan-out — `run-sync` extraction, `sync-tenants` cron, vercel.json

Existing daily route keeps single-tenant behaviour byte-for-byte; multi deployments get a new every-15-minutes route that syncs tenants due (>20 h) inside a 240 s budget. The old route answers 200 `{skipped}` in multi so the daily cron stays green on both modes.

**Files:**
- Create: `lib/prices/run-sync.ts`
- Modify: `app/api/cron/sync-prices/route.ts` (slim down)
- Create: `app/api/cron/sync-tenants/route.ts`
- Test: `app/api/cron/sync-tenants/route.test.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `forEachDueTenant`, `LIVE_STATUSES` (Task 2); `sweepTcgplayerCatalogue`, `syncInStockCardmarket`, `syncStaleCardmarket`, `pruneOldHistory` from `@/lib/prices/sync`.
- Produces: `runFullPriceSync(db: Db): Promise<{ sweep: unknown; cardmarket: unknown; cardmarketRotation: unknown }>` — the per-tenant sync used by both cron routes.

- [ ] **Step 1: Write the failing route test** — `app/api/cron/sync-tenants/route.test.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIGINAL = { CRON_SECRET: process.env.CRON_SECRET, TENANCY_MODE: process.env.TENANCY_MODE }
afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL.CRON_SECRET
  if (ORIGINAL.TENANCY_MODE === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = ORIGINAL.TENANCY_MODE
})

function req(auth?: string) {
  return new NextRequest('http://localhost/api/cron/sync-tenants',
    auth ? { headers: { authorization: auth } } : undefined)
}

test('401s without the cron secret (and with no secret configured at all)', async () => {
  delete process.env.CRON_SECRET
  assert.equal((await GET(req())).status, 401)
  assert.equal((await GET(req('Bearer undefined'))).status, 401)
  process.env.CRON_SECRET = 's3cret'
  assert.equal((await GET(req('Bearer wrong'))).status, 401)
})

test('no-ops green in single-tenant mode', async () => {
  process.env.CRON_SECRET = 's3cret'
  delete process.env.TENANCY_MODE
  const res = await GET(req('Bearer s3cret'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { skipped: 'single-tenant' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 "sync-tenants"`
Expected: FAIL — module `./route` not found.

- [ ] **Step 3: Implement.** First `lib/prices/run-sync.ts` (moved verbatim from the old route's `syncOne`, comment included):

```ts
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import type { Db } from '@/lib/db'

// One tenant's full nightly refresh. Full-catalogue TCGplayer sweep (also
// picks up newly released sets), then per-card Cardmarket for in-stock, then
// a bounded stalest-first Cardmarket rotation over the rest of the catalogue
// (so buylist offers for unstocked cards aren't left on the USD fallback),
// then history retention. Rotation runs after the in-stock sync so freshly
// synced stock sorts to the back of the rotation queue instead of being
// fetched twice.
export async function runFullPriceSync(db: Db) {
  const settings = await getSettings(db)
  const sweep = await sweepTcgplayerCatalogue(settings, {}, db)
  const cardmarket = await syncInStockCardmarket(settings, db)
  const cardmarketRotation = await syncStaleCardmarket(settings, {}, db)
  await pruneOldHistory(db)
  return { sweep, cardmarket, cardmarketRotation }
}
```

Then rewrite `app/api/cron/sync-prices/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb, isMultiTenant } from '@/lib/db'
import { runFullPriceSync } from '@/lib/prices/run-sync'

// Full catalogue sweep takes minutes — allow the platform maximum
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret there is no valid Authorization
  // header, so an unset CRON_SECRET can never be matched by `Bearer undefined`.
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (isMultiTenant()) {
    // Multi deployments sync via /api/cron/sync-tenants (cursor-staggered,
    // spec §3.7). 200 so the daily cron stays green on both modes.
    return NextResponse.json({ skipped: 'multi-tenant' })
  }
  return NextResponse.json(await runFullPriceSync(await getTenantDb()))
}
```

Then `app/api/cron/sync-tenants/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { tenantSyncState } from '@/lib/platform/schema'
import { forEachDueTenant } from '@/lib/platform/fanout'
import { runFullPriceSync } from '@/lib/prices/run-sync'
import { captureException } from '@/lib/observability'

// Cursor-staggered price sync (spec §3.7): runs every 15 minutes; each
// invocation refreshes the tenants whose last sync is >20h old, oldest
// first, inside a 240s budget (maxDuration leaves headroom to finish the
// tenant in flight). A full sweep is minutes per tenant, so one invocation
// handles a few tenants and the fleet is covered daily with lots of slack.
export const maxDuration = 300
const BUDGET_MS = 240_000
const DUE_AFTER_S = 20 * 3600

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isMultiTenant()) {
    return NextResponse.json({ skipped: 'single-tenant' })
  }
  const pdb = getPlatformDb()
  const result = await forEachDueTenant(
    { pdb, field: 'lastPriceSyncAt', dueAfterSeconds: DUE_AFTER_S, budgetMs: BUDGET_MS },
    async (tenant) => {
      await runFullPriceSync(getTenantDbFor(String(tenant.id), tenant.dbUrl))
      // The sweep refreshes the catalogue too; keep that cursor honest for
      // the admin overview.
      await pdb.update(tenantSyncState)
        .set({ lastCatalogueSyncAt: Math.floor(Date.now() / 1000) })
        .where(eq(tenantSyncState.tenantId, tenant.id))
    },
  )
  for (const p of result.processed) {
    if (!p.ok) await captureException(new Error(`price sync failed for ${p.slug}: ${p.error}`))
  }
  return NextResponse.json(result)
}
```

**Note:** `lib/observability.ts` arrives in Task 12. To keep this task self-contained and green, create the seam now as a stub file `lib/observability.ts`:

```ts
// Error-reporting seam. No-op unless SENTRY_DSN is set (Task 12 wires Sentry).
export async function captureException(e: unknown): Promise<void> {
  if (!process.env.SENTRY_DSN) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.captureException(e)
  } catch { /* reporting must never break the request */ }
}
```

Then `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/sync-prices", "schedule": "0 3 * * *" },
    { "path": "/api/cron/sync-tenants", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/backup-tenants", "schedule": "30 * * * *" }
  ]
}
```

(The backup route lands in Task 5; Vercel tolerates the entry meanwhile only on deploys after that task — this branch merges as one PR, so the config is consistent at deploy time.)

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: new route tests PASS; whole suite green (the old cron route has no tests of its own; `tests/tenancy-guard.test.ts` still passes — neither route imports the singleton).

- [ ] **Step 5: Commit**

```bash
git add lib/prices/run-sync.ts lib/observability.ts app/api/cron/ vercel.json
git commit -m "feat(platform): cursor-staggered sync-tenants cron; sync-prices is single-mode only"
```

---

### Task 4: Portable logical dump — `lib/db/dump.ts`

One module both backups (SQL dump) and the restore script/tests share. Provider-agnostic: works on `:memory:`, `file:`, and `libsql:` DBs because it's plain SELECTs. Statements are joined with the repo's own `--> statement-breakpoint` separator so restore never parses SQL.

**Files:**
- Create: `lib/db/dump.ts`
- Test: `lib/db/dump.test.ts`

**Interfaces:**
- Consumes: `Db` from `@/lib/db`; `Client` from `@libsql/client`.
- Produces:

```ts
export async function listUserTables(db: Db): Promise<string[]>
export async function dumpDatabaseSql(db: Db): Promise<string>       // full logical dump
export async function replaySqlDump(client: Client, dump: string): Promise<number>  // statements applied
```

- [ ] **Step 1: Write the failing test** — `lib/db/dump.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import * as schema from '@/lib/db/schema'
import { cards, customers } from '@/lib/db/schema'
import { listUserTables, dumpDatabaseSql, replaySqlDump } from './dump'

test('listUserTables sees the tenant schema and skips sqlite internals', async () => {
  const db = await createTestDb()
  const tables = await listUserTables(db)
  assert.ok(tables.includes('cards'))
  assert.ok(tables.includes('sales'))
  assert.ok(tables.includes('settings'))
  assert.ok(!tables.some(t => t.startsWith('sqlite_')))
})

test('dump → replay round-trips schema and data, including hostile strings', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.insert(cards).values({
    id: 'weird-1', name: "O'Malley's \"Pikachu\"\nline2", setName: '=EVIL()+1', setNumber: '1/1',
  })
  await db.insert(customers).values({ name: 'Ünïcødé 🃏', email: 'x@y.z' })

  const dump = await dumpDatabaseSql(db)
  const restored = createClient({ url: ':memory:' })
  const applied = await replaySqlDump(restored, dump)
  assert.ok(applied > 10, `expected many statements, got ${applied}`)

  const rdb = drizzle(restored, { schema })
  const sourceTables = await listUserTables(db)
  const restoredTables = await listUserTables(rdb)
  assert.deepEqual(restoredTables, sourceTables)

  for (const t of sourceTables) {
    const [a] = await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t}"`))
    const [b] = await rdb.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t}"`))
    assert.equal(b.n, a.n, `row count for ${t}`)
  }

  const [card] = await rdb.select().from(cards).where(sql`${cards.id} = 'weird-1'`)
  assert.equal(card.name, "O'Malley's \"Pikachu\"\nline2")
  assert.equal(card.setName, '=EVIL()+1')
  const [cust] = await rdb.select().from(customers)
  assert.equal(cust.name, 'Ünïcødé 🃏')
})

test('replaying a dump onto itself again fails loudly (no silent double-restore)', async () => {
  const db = await createTestDb()
  const dump = await dumpDatabaseSql(db)
  const restored = createClient({ url: ':memory:' })
  await replaySqlDump(restored, dump)
  await assert.rejects(replaySqlDump(restored, dump))   // CREATE TABLE already exists
})
```

(If `cards`/`customers` column names differ from the values above, adjust the inserts to the real `lib/db/schema.ts` shapes — read it, don't modify it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 "dump"`
Expected: FAIL — module `./dump` not found.

- [ ] **Step 3: Implement** — `lib/db/dump.ts`:

```ts
import type { Client } from '@libsql/client'
import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'

// Portable logical dump of one tenant DB: CREATE statements from
// sqlite_master plus batched INSERT literals, joined with the repo's
// migration separator so restore replays statements without parsing SQL.
// Provider-agnostic on purpose (spec §3.9): the same code dumps :memory:
// test DBs, file: dev DBs and libsql: production DBs, and the output
// restores into any of them.

export const DUMP_STATEMENT_SEPARATOR = '\n--> statement-breakpoint\n'

// Runtime bookkeeping, not shop data.
const SKIP_TABLES = new Set(['sqlite_sequence', 'libsql_wasm_func_table', '_litestream_seq', '_litestream_lock'])

export async function listUserTables(db: Db): Promise<string[]> {
  const rows = await db.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`)
  return rows.map(r => r.name).filter(n => !SKIP_TABLES.has(n))
}

const INSERT_BATCH = 200   // keeps each statement well under SQLite's 1MB SQL limit

export async function dumpDatabaseSql(db: Db): Promise<string> {
  const objects = await db.all<{ name: string; type: string; sql: string | null }>(sql`
    SELECT name, type, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`)

  const tables = objects.filter(o => o.type === 'table' && !SKIP_TABLES.has(o.name))
  const statements: string[] = ['PRAGMA foreign_keys=OFF']

  for (const t of tables) statements.push(t.sql!)

  for (const t of tables) {
    const rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${t.name}"`))
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH)
      const cols = Object.keys(batch[0])
      const values = batch
        .map(r => `(${cols.map(c => sqlLiteral(r[c])).join(',')})`)
        .join(',\n')
      statements.push(`INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES\n${values}`)
    }
  }

  // Indexes and triggers after data: restore is faster and trigger side
  // effects can't fire during the INSERT replay.
  for (const o of objects) {
    if (o.type !== 'table' && !SKIP_TABLES.has(o.name)) statements.push(o.sql!)
  }

  return statements.join(DUMP_STATEMENT_SEPARATOR)
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof ArrayBuffer) return `X'${Buffer.from(new Uint8Array(v)).toString('hex')}'`
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

// Counterpart used by scripts/restore-backup.ts and the drill runbook.
export async function replaySqlDump(client: Client, dump: string): Promise<number> {
  let applied = 0
  for (const statement of dump.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) {
      await client.execute(trimmed)
      applied++
    }
  }
  return applied
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/dump.ts lib/db/dump.test.ts
git commit -m "feat: portable logical SQL dump + replay for tenant DBs"
```

---

### Task 5: Backups — store abstraction, backup lib, cron route, restore script

**Files:**
- Create: `lib/platform/backup-store.ts`
- Create: `lib/platform/backup.ts`
- Create: `app/api/cron/backup-tenants/route.ts`
- Create: `scripts/restore-backup.ts`
- Test: `lib/platform/backup.test.ts`, `app/api/cron/backup-tenants/route.test.ts`

**Interfaces:**
- Consumes: `dumpDatabaseSql`, `replaySqlDump` (Task 4); `forEachDueTenant` (Task 2).
- Produces:

```ts
// backup-store.ts
export interface BackupObject { key: string; url: string; uploadedAt: number }   // epoch s
export interface BackupStore {
  put(key: string, data: Uint8Array): Promise<void>
  list(prefix: string): Promise<BackupObject[]>
  del(urls: string[]): Promise<void>
}
export function getBackupStore(): BackupStore | null       // null unless BLOB_READ_WRITE_TOKEN
export function memoryBackupStore(): BackupStore & { objects: Map<string, Uint8Array> }  // tests

// backup.ts
export function backupKey(slug: string, now?: Date): string    // backups/<slug>/<YYYY-MM-DDTHH-MM-SSZ>.sql.gz
export async function backupDatabase(store: BackupStore, slug: string, db: Db, now?: Date): Promise<{ key: string; bytes: number }>
export async function pruneBackups(store: BackupStore, slug: string, retentionDays: number, now?: Date): Promise<number>
```

- [ ] **Step 1: Install the dependency**

Run: `npm install @vercel/blob`
Expected: added to `package.json` dependencies.

- [ ] **Step 2: Write the failing test** — `lib/platform/backup.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { gunzipSync } from 'node:zlib'
import { createClient } from '@libsql/client'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { replaySqlDump, listUserTables } from '@/lib/db/dump'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '@/lib/db/schema'
import { memoryBackupStore, getBackupStore } from './backup-store'
import { backupKey, backupDatabase, pruneBackups } from './backup'

test('getBackupStore is null without BLOB_READ_WRITE_TOKEN (feature off by default)', () => {
  const orig = process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.BLOB_READ_WRITE_TOKEN
  assert.equal(getBackupStore(), null)
  if (orig !== undefined) process.env.BLOB_READ_WRITE_TOKEN = orig
})

test('backupKey is date-stamped under the tenant prefix', () => {
  const key = backupKey('brads-cards', new Date('2026-07-18T03:30:00Z'))
  assert.equal(key, 'backups/brads-cards/2026-07-18T03-30-00Z.sql.gz')
})

test('backupDatabase writes a gzipped dump that restores', async () => {
  const db = await createTestDb()
  await seedBase(db)
  const store = memoryBackupStore()
  const { key, bytes } = await backupDatabase(store, 'shop-a', db, new Date('2026-07-18T03:00:00Z'))
  assert.ok(bytes > 0)
  const gz = store.objects.get(key)!
  const dump = gunzipSync(Buffer.from(gz)).toString('utf8')
  const restored = createClient({ url: ':memory:' })
  await replaySqlDump(restored, dump)
  const tables = await listUserTables(drizzle(restored, { schema }))
  assert.ok(tables.includes('settings'))
})

test('pruneBackups deletes only objects older than retention', async () => {
  const store = memoryBackupStore()
  const now = new Date('2026-07-18T00:00:00Z')
  const old = new Date('2026-07-01T00:00:00Z')     // 17 days: prune at 14
  const fresh = new Date('2026-07-10T00:00:00Z')   // 8 days: keep
  await backupDatabase(store, 'shop-a', await createTestDb(), old)
  await backupDatabase(store, 'shop-a', await createTestDb(), fresh)
  await backupDatabase(store, 'shop-b', await createTestDb(), old)  // other tenant untouched
  const pruned = await pruneBackups(store, 'shop-a', 14, now)
  assert.equal(pruned, 1)
  const remaining = await store.list('backups/shop-a/')
  assert.equal(remaining.length, 1)
  assert.equal((await store.list('backups/shop-b/')).length, 1)
})
```

And `app/api/cron/backup-tenants/route.test.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIG = { CRON_SECRET: process.env.CRON_SECRET, BLOB: process.env.BLOB_READ_WRITE_TOKEN }
afterEach(() => {
  process.env.CRON_SECRET = ORIG.CRON_SECRET
  if (ORIG.BLOB === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
  else process.env.BLOB_READ_WRITE_TOKEN = ORIG.BLOB
})

test('401 without secret; skips green without a blob token', async () => {
  delete process.env.CRON_SECRET
  const unauth = await GET(new NextRequest('http://localhost/api/cron/backup-tenants'))
  assert.equal(unauth.status, 401)

  process.env.CRON_SECRET = 's3cret'
  delete process.env.BLOB_READ_WRITE_TOKEN
  const res = await GET(new NextRequest('http://localhost/api/cron/backup-tenants',
    { headers: { authorization: 'Bearer s3cret' } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { skipped: 'no-blob-token' })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 -i backup`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement.** `lib/platform/backup-store.ts`:

```ts
// Where backup dumps live. Vercel Blob in production (spec §3.9), an
// in-memory map in tests. Feature-gated: no BLOB_READ_WRITE_TOKEN → no store
// → the backup cron no-ops green.

export interface BackupObject { key: string; url: string; uploadedAt: number }

export interface BackupStore {
  put(key: string, data: Uint8Array): Promise<void>
  list(prefix: string): Promise<BackupObject[]>
  del(urls: string[]): Promise<void>
}

export function getBackupStore(): BackupStore | null {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null
  return {
    async put(key, data) {
      const { put } = await import('@vercel/blob')
      // Backups are shop data — never on public URLs.
      await put(key, Buffer.from(data), {
        access: 'private', addRandomSuffix: false, contentType: 'application/gzip',
      })
    },
    async list(prefix) {
      const { list } = await import('@vercel/blob')
      const out: BackupObject[] = []
      let cursor: string | undefined
      do {
        const page = await list({ prefix, cursor, limit: 1000 })
        for (const b of page.blobs) {
          out.push({ key: b.pathname, url: b.url, uploadedAt: Math.floor(new Date(b.uploadedAt).getTime() / 1000) })
        }
        cursor = page.hasMore ? page.cursor : undefined
      } while (cursor)
      return out
    },
    async del(urls) {
      if (urls.length === 0) return
      const { del } = await import('@vercel/blob')
      await del(urls)
    },
  }
}

export function memoryBackupStore(): BackupStore & { objects: Map<string, Uint8Array>; uploadedAt: Map<string, number> } {
  const objects = new Map<string, Uint8Array>()
  const uploadedAt = new Map<string, number>()
  return {
    objects,
    uploadedAt,
    async put(key, data) { objects.set(key, data) },
    async list(prefix) {
      return [...objects.keys()].filter(k => k.startsWith(prefix))
        .map(k => ({ key: k, url: k, uploadedAt: uploadedAt.get(k) ?? 0 }))
    },
    async del(urls) { for (const u of urls) { objects.delete(u); uploadedAt.delete(u) } },
  }
}
```

**Implementation note (verify at build):** if the installed `@vercel/blob` types reject `access: 'private'`, STOP — do not fall back to `'public'` for shop data. Check the SDK's private-access API name (it shipped after the public-only era) and use that; the runbook (Task 13) tells the founder to create the store with private access.

`memoryBackupStore` needs `uploadedAt` stamped by `backupDatabase`'s `now` — see `backup.ts`: after `store.put`, tests read timestamps via `list()`. To keep the store dumb, `backupDatabase` passes nothing extra: the memory store stamps `uploadedAt.set(key, Math.floor(Date.now()/1000))` in `put`. For the prune test to work with synthetic dates, derive `uploadedAt` in `pruneBackups` **from the key's date stamp, not the store timestamp** — the key embeds the backup time. So `pruneBackups` parses `backups/<slug>/<stamp>.sql.gz`, and `BackupObject.uploadedAt` is only a fallback for foreign keys. Implement `pruneBackups` accordingly (below) and keep the memory store's `uploadedAt` map but don't rely on it in tests.

`lib/platform/backup.ts`:

```ts
import { gzipSync } from 'node:zlib'
import { dumpDatabaseSql } from '@/lib/db/dump'
import type { Db } from '@/lib/db'
import type { BackupStore } from './backup-store'

// Nightly-ish belt-and-braces dumps (spec §3.9): Turso PITR is the primary
// restore path; these gzipped logical dumps are the provider-independent
// artefact the monthly restore drill exercises.

export const BACKUP_DUE_AFTER_S = 20 * 3600

export function backupKey(slug: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z'
  return `backups/${slug}/${stamp}.sql.gz`
}

// backups/<slug>/2026-07-18T03-30-00Z.sql.gz → epoch seconds (null if foreign)
export function backupKeyTime(key: string): number | null {
  const m = key.match(/\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sql\.gz$/)
  if (!m) return null
  return Math.floor(Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) / 1000)
}

export async function backupDatabase(
  store: BackupStore, slug: string, db: Db, now: Date = new Date(),
): Promise<{ key: string; bytes: number }> {
  const dump = await dumpDatabaseSql(db)
  const gz = gzipSync(Buffer.from(dump, 'utf8'))
  const key = backupKey(slug, now)
  await store.put(key, gz)
  return { key, bytes: gz.byteLength }
}

export async function pruneBackups(
  store: BackupStore, slug: string, retentionDays: number, now: Date = new Date(),
): Promise<number> {
  const cutoff = Math.floor(now.getTime() / 1000) - retentionDays * 86400
  const objects = await store.list(`backups/${slug}/`)
  const stale = objects.filter(o => (backupKeyTime(o.key) ?? o.uploadedAt) < cutoff)
  await store.del(stale.map(o => o.url))
  return stale.length
}
```

`app/api/cron/backup-tenants/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb, getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { forEachDueTenant } from '@/lib/platform/fanout'
import { getBackupStore } from '@/lib/platform/backup-store'
import { backupDatabase, pruneBackups, BACKUP_DUE_AFTER_S } from '@/lib/platform/backup'
import { captureException } from '@/lib/observability'

// Hourly; each invocation backs up tenants whose last dump is >20h old, so
// the fleet is covered daily and a missed hour self-heals. Single-tenant
// deployments (Wizard-of-Oz beta shops) get the same protection for their
// one DB under backups/single-tenant/.
export const maxDuration = 300
const BUDGET_MS = 240_000

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const store = getBackupStore()
  if (!store) return NextResponse.json({ skipped: 'no-blob-token' })
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? '14')

  if (!isMultiTenant()) {
    const result = await backupDatabase(store, 'single-tenant', await getTenantDb())
    const pruned = await pruneBackups(store, 'single-tenant', retentionDays)
    return NextResponse.json({ ...result, pruned })
  }

  const result = await forEachDueTenant(
    { pdb: getPlatformDb(), field: 'lastBackupAt', dueAfterSeconds: BACKUP_DUE_AFTER_S, budgetMs: BUDGET_MS },
    async (tenant) => {
      await backupDatabase(store, tenant.slug, getTenantDbFor(String(tenant.id), tenant.dbUrl))
      await pruneBackups(store, tenant.slug, retentionDays)
    },
  )
  for (const p of result.processed) {
    if (!p.ok) await captureException(new Error(`backup failed for ${p.slug}: ${p.error}`))
  }
  return NextResponse.json(result)
}
```

`scripts/restore-backup.ts`:

```ts
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createClient } from '@libsql/client'
import { replaySqlDump } from '../lib/db/dump'

// Restore a backup dump into an EMPTY database. Part of the monthly restore
// drill — see docs/runbooks/backup-restore-drill.md.
//
//   npx tsx scripts/restore-backup.ts <dump.sql.gz> <target-db-url> [auth-token]
//
// e.g. npx tsx scripts/restore-backup.ts ./2026-07-18T03-30-00Z.sql.gz file:./drill.db

async function main() {
  const [dumpPath, targetUrl, authToken] = process.argv.slice(2)
  if (!dumpPath || !targetUrl) {
    console.error('usage: npx tsx scripts/restore-backup.ts <dump.sql.gz> <target-db-url> [auth-token]')
    process.exit(1)
  }
  const raw = readFileSync(dumpPath)
  const dump = dumpPath.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')

  const client = createClient({ url: targetUrl, authToken })
  const existing = await client.execute(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  if (Number(existing.rows[0].n) > 0) {
    console.error(`Refusing to restore: target already has ${existing.rows[0].n} tables. Restore into an empty DB.`)
    process.exit(1)
  }

  const applied = await replaySqlDump(client, dump)
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  console.log(`Applied ${applied} statements. Restored tables:`)
  for (const row of tables.rows) {
    const n = await client.execute(`SELECT count(*) AS n FROM "${row.name}"`)
    console.log(`  ${row.name}: ${n.rows[0].n} rows`)
  }
  client.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: backup lib + route tests PASS; suite green.

- [ ] **Step 6: Smoke the restore script end-to-end locally**

```bash
npx tsx -e "
import { createTestDb, seedBase } from './lib/db/test-helpers';
import { backupDatabase } from './lib/platform/backup';
import { memoryBackupStore } from './lib/platform/backup-store';
import { writeFileSync } from 'node:fs';
const db = await createTestDb(); await seedBase(db);
const store = memoryBackupStore();
const { key } = await backupDatabase(store, 'smoke', db);
writeFileSync('/tmp/smoke.sql.gz', Buffer.from(store.objects.get(key)));
console.log('wrote /tmp/smoke.sql.gz');
"
npx tsx scripts/restore-backup.ts /tmp/smoke.sql.gz file:/tmp/drill-smoke.db
rm -f /tmp/drill-smoke.db* /tmp/smoke.sql.gz
```

Expected: "Applied N statements" + per-table row counts, `settings: 1 rows` present.

- [ ] **Step 7: Commit**

```bash
git add lib/platform/backup-store.ts lib/platform/backup.ts lib/platform/backup.test.ts \
  app/api/cron/backup-tenants/ scripts/restore-backup.ts package.json package-lock.json
git commit -m "feat(platform): tenant backup cron to Vercel Blob + restore script"
```

---

### Task 6: Platform-admin auth — lib + login/logout routes

**Files:**
- Create: `lib/platform/admin-auth.ts`
- Create: `app/api/platform/admin/login/route.ts`
- Test: `lib/platform/admin-auth.test.ts`, `app/api/platform/admin/login/route.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AdminSessionData { isPlatformAdmin?: boolean }
export const adminSessionOptions: SessionOptions     // cookie 'platform-admin-session', 12h
export async function getAdminSession(): Promise<IronSession<AdminSessionData>>
export async function verifyAdminPassword(password: string): Promise<boolean>   // false when env unset
export function requirePlatformAdmin(s: AdminSessionData): void                 // throws UNAUTHORIZED
```

- [ ] **Step 1: Write the failing tests** — `lib/platform/admin-auth.test.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import bcrypt from 'bcryptjs'
import { verifyAdminPassword, requirePlatformAdmin, adminSessionOptions } from './admin-auth'

const ORIG = process.env.PLATFORM_ADMIN_PASSWORD_HASH
afterEach(() => {
  if (ORIG === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  else process.env.PLATFORM_ADMIN_PASSWORD_HASH = ORIG
})

test('verifyAdminPassword fails closed when the env hash is unset', async () => {
  delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  assert.equal(await verifyAdminPassword('anything'), false)
})

test('verifyAdminPassword compares against the env bcrypt hash', async () => {
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('hunter2', 4)
  assert.equal(await verifyAdminPassword('hunter2'), true)
  assert.equal(await verifyAdminPassword('wrong'), false)
})

test('requirePlatformAdmin throws UNAUTHORIZED without the flag', () => {
  assert.throws(() => requirePlatformAdmin({}), /Platform admin/)
  assert.doesNotThrow(() => requirePlatformAdmin({ isPlatformAdmin: true }))
})

test('admin cookie is its own name, not the shop session cookie', () => {
  assert.equal(adminSessionOptions.cookieName, 'platform-admin-session')
})
```

And `app/api/platform/admin/login/route.test.ts` (paths that don't need request-scoped cookies):

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert'
import bcrypt from 'bcryptjs'
import { NextRequest } from 'next/server'
import { resetRateLimits } from '@/lib/platform/rate-limit'
import { POST } from './route'

const ORIG = { MODE: process.env.TENANCY_MODE, HASH: process.env.PLATFORM_ADMIN_PASSWORD_HASH }
afterEach(() => {
  if (ORIG.MODE === undefined) delete process.env.TENANCY_MODE; else process.env.TENANCY_MODE = ORIG.MODE
  if (ORIG.HASH === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD_HASH
  else process.env.PLATFORM_ADMIN_PASSWORD_HASH = ORIG.HASH
  resetRateLimits()
})

function loginReq(body: unknown, ip = '10.0.0.1') {
  return new NextRequest('http://admin.example-brand.co.uk/api/platform/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

test('404 in single-tenant mode', async () => {
  delete process.env.TENANCY_MODE
  assert.equal((await POST(loginReq({ password: 'x' }))).status, 404)
})

test('401 on a wrong password', async () => {
  process.env.TENANCY_MODE = 'multi'
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct', 4)
  const res = await POST(loginReq({ password: 'wrong' }))
  assert.equal(res.status, 401)
})

test('429 after 10 attempts from one IP', async () => {
  process.env.TENANCY_MODE = 'multi'
  process.env.PLATFORM_ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct', 4)
  for (let i = 0; i < 10; i++) await POST(loginReq({ password: 'wrong' }, '10.9.9.9'))
  const res = await POST(loginReq({ password: 'wrong' }, '10.9.9.9'))
  assert.equal(res.status, 429)
  const other = await POST(loginReq({ password: 'wrong' }, '10.8.8.8'))
  assert.equal(other.status, 401)   // per-IP, not global
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 "admin"`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement.** `lib/platform/admin-auth.ts`:

```ts
import { getIronSession, IronSession, SessionOptions } from 'iron-session'
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { DomainError } from '@/lib/domain/errors'

// Founders-only platform admin (spec §3.4): env-based password, its own
// cookie on the admin host — completely separate from shop sessions.

export interface AdminSessionData { isPlatformAdmin?: boolean }

export const adminSessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'platform-admin-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 12,
  },
}

export async function getAdminSession(): Promise<IronSession<AdminSessionData>> {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const hash = process.env.PLATFORM_ADMIN_PASSWORD_HASH
  if (!hash) return false   // fail closed: no env hash → nobody authenticates
  return bcrypt.compare(password, hash)
}

export function requirePlatformAdmin(s: AdminSessionData): void {
  if (!s.isPlatformAdmin) throw new DomainError('UNAUTHORIZED', 'Platform admin login required')
}
```

`app/api/platform/admin/login/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { rateLimit } from '@/lib/platform/rate-limit'
import { getAdminSession, verifyAdminPassword } from '@/lib/platform/admin-auth'

const loginBody = z.object({ password: z.string().min(1) })

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`admin-login:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts — try again in a few minutes')
  }
  const { password } = await parseBody(req, loginBody)
  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }
  const session = await getAdminSession()
  session.isPlatformAdmin = true
  await session.save()
  return NextResponse.json({ ok: true })
})

export const DELETE = guarded(async () => {
  const session = await getAdminSession()
  session.destroy()
  return NextResponse.json({ ok: true })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (the 401 test exercises `verifyAdminPassword` before any cookie access, so no request context is needed).

- [ ] **Step 5: Commit**

```bash
git add lib/platform/admin-auth.ts lib/platform/admin-auth.test.ts app/api/platform/admin/
git commit -m "feat(platform): platform-admin auth (env hash, own cookie, rate-limited login)"
```

---

### Task 7: Impersonation — grant/consume lib + admin route + shop-host consume route

**Files:**
- Create: `lib/platform/impersonation.ts`
- Create: `app/api/platform/admin/impersonate/route.ts`
- Create: `app/api/auth/impersonate/route.ts`
- Modify: `lib/auth.ts` (add `impersonated?: boolean` to `SessionData` — one line)
- Modify: `proxy.ts` (add `'/api/auth/impersonate'` to `PUBLIC_PATHS` — one line)
- Test: `lib/platform/impersonation.test.ts`

**Interfaces:**
- Consumes: `impersonationGrants` (Task 1), `getAdminSession`/`requirePlatformAdmin` (Task 6), `tenantUrl`.
- Produces:

```ts
export const GRANT_TTL_S = 60
export async function createImpersonationGrant(tenantId: number,
  opts?: { pdb?: PlatformDb; baseHost?: string; nowS?: number }): Promise<{ url: string } | null>
export async function consumeImpersonationGrant(token: string,
  opts?: { pdb?: PlatformDb; nowS?: number }): Promise<Tenant | null>
```

- [ ] **Step 1: Write the failing test** — `lib/platform/impersonation.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { createTestPlatformDb } from './test-helpers'
import { tenants, platformAudit } from './schema'
import { createImpersonationGrant, consumeImpersonationGrant, GRANT_TTL_S } from './impersonation'

const BASE = 'example-brand.co.uk'

async function seed(pdb: Awaited<ReturnType<typeof createTestPlatformDb>>) {
  const [t] = await pdb.insert(tenants)
    .values({ slug: 'brads-cards', name: "Brad's", dbUrl: 'file:x.db', status: 'active' }).returning()
  return t
}

test('grant → consume round-trip mints once and audits both ends', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seed(pdb)
  const grant = await createImpersonationGrant(t.id, { pdb, baseHost: BASE, nowS: 1000 })
  assert.ok(grant!.url.startsWith(`https://brads-cards.${BASE}/api/auth/impersonate?token=`))
  const token = new URL(grant!.url).searchParams.get('token')!
  assert.equal(token.length, 64)

  const consumed = await consumeImpersonationGrant(token, { pdb, nowS: 1030 })
  assert.equal(consumed?.id, t.id)

  // Single-use: the second consume is a dead token.
  assert.equal(await consumeImpersonationGrant(token, { pdb, nowS: 1031 }), null)

  const audit = await pdb.select().from(platformAudit)
  assert.deepEqual(audit.map(a => a.action), ['impersonate_grant', 'impersonate_login'])
  assert.deepEqual(audit.map(a => a.tenantId), [t.id, t.id])
})

test('expired grants and garbage tokens are rejected', async () => {
  const pdb = await createTestPlatformDb()
  const t = await seed(pdb)
  const grant = await createImpersonationGrant(t.id, { pdb, baseHost: BASE, nowS: 1000 })
  const token = new URL(grant!.url).searchParams.get('token')!
  assert.equal(await consumeImpersonationGrant(token, { pdb, nowS: 1000 + GRANT_TTL_S + 1 }), null)
  assert.equal(await consumeImpersonationGrant('feedfacecafebeef', { pdb, nowS: 1001 }), null)
})

test('granting for an unknown tenant returns null and writes no audit row', async () => {
  const pdb = await createTestPlatformDb()
  assert.equal(await createImpersonationGrant(999, { pdb, baseHost: BASE, nowS: 0 }), null)
  assert.equal((await pdb.select().from(platformAudit)).length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 impersonation`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** `lib/platform/impersonation.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getPlatformDb, type PlatformDb } from './db'
import { impersonationGrants, platformAudit, tenants, type Tenant } from './schema'
import { tenantUrl } from './tenants'

// "Open shop as owner" (spec §3.4): the admin dashboard mints a single-use
// 60s grant; the shop host burns it and mints the tenant session. Only the
// sha256 of the token ever touches the registry, and both ends write to
// platform_audit.

export const GRANT_TTL_S = 60

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function createImpersonationGrant(
  tenantId: number,
  opts: { pdb?: PlatformDb; baseHost?: string; nowS?: number } = {},
): Promise<{ url: string } | null> {
  const pdb = opts.pdb ?? getPlatformDb()
  const baseHost = opts.baseHost ?? process.env.PLATFORM_BASE_HOST
  if (!baseHost) throw new Error('PLATFORM_BASE_HOST is not set')
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000)

  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!tenant) return null

  const token = randomBytes(32).toString('hex')
  await pdb.insert(impersonationGrants)
    .values({ tokenHash: sha256(token), tenantId, expiresAt: nowS + GRANT_TTL_S })
  await pdb.insert(platformAudit)
    .values({ actor: 'platform_admin', tenantId, action: 'impersonate_grant', detail: tenant.slug })
  return { url: tenantUrl(tenant.slug, baseHost, `/api/auth/impersonate?token=${token}`) }
}

export async function consumeImpersonationGrant(
  token: string,
  opts: { pdb?: PlatformDb; nowS?: number } = {},
): Promise<Tenant | null> {
  const pdb = opts.pdb ?? getPlatformDb()
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000)

  // Atomic single-use: the UPDATE only matches an unused, unexpired row, so
  // two racing consumes can't both win.
  const claimed = await pdb.update(impersonationGrants)
    .set({ usedAt: nowS })
    .where(and(
      eq(impersonationGrants.tokenHash, sha256(token)),
      isNull(impersonationGrants.usedAt),
      gt(impersonationGrants.expiresAt, nowS),
    ))
    .returning()
  if (claimed.length === 0) return null

  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.id, claimed[0].tenantId)).limit(1)
  if (!tenant) return null
  await pdb.insert(platformAudit)
    .values({ actor: 'platform_admin', tenantId: tenant.id, action: 'impersonate_login', detail: tenant.slug })
  return tenant
}
```

`app/api/platform/admin/impersonate/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession, requirePlatformAdmin } from '@/lib/platform/admin-auth'
import { createImpersonationGrant } from '@/lib/platform/impersonation'

const impersonateBody = z.object({ tenantId: z.number().int().positive() })

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  requirePlatformAdmin(await getAdminSession())
  const { tenantId } = await parseBody(req, impersonateBody)
  const grant = await createImpersonationGrant(tenantId)
  if (!grant) return NextResponse.json({ error: 'Unknown tenant' }, { status: 404 })
  return NextResponse.json(grant)
})
```

`app/api/auth/impersonate/route.ts` (shop host — burns the token, mints the session):

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { guarded } from '@/lib/api'
import { isMultiTenant } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { SessionData, sessionOptions } from '@/lib/auth'
import { rateLimit } from '@/lib/platform/rate-limit'
import { consumeImpersonationGrant } from '@/lib/platform/impersonation'

// Lands here from the admin dashboard's "Open shop" button. The session is
// owner-level with a synthetic staff identity: staffId -1 references no
// staff row, so staff-attributed writes (sales, buys) fail their FK on
// purpose — impersonation is for looking and configuring, not transacting,
// and nothing ever gets attributed to the shop's real staff.
export const GET = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`impersonate:${ip}`, 10, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many attempts')
  }
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

  const tenant = await consumeImpersonationGrant(token)
  if (!tenant) return NextResponse.json({ error: 'Link expired — mint a fresh one from the admin dashboard' }, { status: 404 })

  // The proxy resolved this request's tenant from the Host header; a token
  // minted for shop A must not log anyone into shop B.
  if (req.headers.get('x-tenant-id') !== String(tenant.id)) {
    return NextResponse.json({ error: 'Wrong shop' }, { status: 404 })
  }

  const session = await getIronSession<SessionData>(await cookies(), {
    ...sessionOptions,
    cookieOptions: { ...sessionOptions.cookieOptions, maxAge: 60 * 60 * 4 },   // short leash
  })
  session.isOwnerLoggedIn = true
  session.tenantId = String(tenant.id)
  session.staffId = -1
  session.staffRole = 'admin'
  session.staffName = 'Platform support'
  session.impersonated = true
  await session.save()
  return NextResponse.redirect(new URL('/', req.url))
})
```

`lib/auth.ts` — extend `SessionData`:

```ts
export interface SessionData {
  isOwnerLoggedIn: boolean
  staffId?: number
  staffRole?: 'admin' | 'staff'
  staffName?: string
  tenantId?: string
  impersonated?: boolean   // platform-support session minted via /api/auth/impersonate
}
```

`proxy.ts` — extend `PUBLIC_PATHS`:

```ts
const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/auth/impersonate', '/api/cron/', '/api/health', '/suspended', '/signup', '/api/platform/', '/setup', '/api/setup']
```

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: impersonation tests PASS; suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/platform/impersonation.ts lib/platform/impersonation.test.ts \
  app/api/platform/admin/impersonate/ app/api/auth/impersonate/ lib/auth.ts proxy.ts
git commit -m "feat(platform): audited single-use impersonation (admin grant → shop-host consume)"
```

---

### Task 8: Admin-host routing in the proxy

**Files:**
- Modify: `lib/platform/routing.ts` (add `isAdminHost` + `decideAdminRouting`)
- Modify: `proxy.ts` (admin-host branch; block `/admin` on non-admin hosts)
- Test: `lib/platform/routing.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export function isAdminHost(host: string, baseHost: string): boolean
export type AdminRouting =
  | { kind: 'pass' } | { kind: 'redirect-login' } | { kind: 'rewrite'; path: string } | { kind: 'not-found' }
export function decideAdminRouting(pathname: string, hasAdminSession: boolean): AdminRouting
```

- [ ] **Step 1: Write the failing tests** — append to `lib/platform/routing.test.ts`:

```ts
import { isAdminHost, decideAdminRouting } from './routing'

test('isAdminHost matches only the admin subdomain of the base host', () => {
  assert.equal(isAdminHost('admin.example-brand.co.uk', 'example-brand.co.uk'), true)
  assert.equal(isAdminHost('ADMIN.Example-Brand.co.uk:3000', 'example-brand.co.uk'), true)
  assert.equal(isAdminHost('admin.evil.com', 'example-brand.co.uk'), false)
  assert.equal(isAdminHost('shop.example-brand.co.uk', 'example-brand.co.uk'), false)
  assert.equal(isAdminHost('example-brand.co.uk', 'example-brand.co.uk'), false)
})

test('admin routing: APIs pass (handlers self-gate); login page always reachable', () => {
  assert.deepEqual(decideAdminRouting('/api/platform/admin/login', false), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/api/health', false), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/admin/login', false), { kind: 'pass' })
})

test('admin routing: pages gate on the session', () => {
  assert.deepEqual(decideAdminRouting('/admin', false), { kind: 'redirect-login' })
  assert.deepEqual(decideAdminRouting('/', false), { kind: 'redirect-login' })
  assert.deepEqual(decideAdminRouting('/admin', true), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/admin/audit', true), { kind: 'pass' })
  assert.deepEqual(decideAdminRouting('/', true), { kind: 'rewrite', path: '/admin' })
})

test('admin routing: shop paths do not exist on the admin host', () => {
  assert.deepEqual(decideAdminRouting('/pos', true), { kind: 'not-found' })
  assert.deepEqual(decideAdminRouting('/login', false), { kind: 'not-found' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 "admin routing"`
Expected: FAIL — `isAdminHost` not exported.

- [ ] **Step 3: Implement.** Append to `lib/platform/routing.ts`:

```ts
// Admin host (spec §3.4): founders' dashboard on admin.<base>.
export function isAdminHost(host: string, baseHost: string): boolean {
  return host.trim().toLowerCase().split(':')[0] === `admin.${baseHost.toLowerCase()}`
}

export type AdminRouting =
  | { kind: 'pass' }
  | { kind: 'redirect-login' }
  | { kind: 'rewrite'; path: string }
  | { kind: 'not-found' }

export function decideAdminRouting(pathname: string, hasAdminSession: boolean): AdminRouting {
  // API handlers enforce the admin session themselves (requirePlatformAdmin);
  // shop APIs called here have no tenant headers and 401 in getTenantDb.
  if (pathname.startsWith('/api/')) return { kind: 'pass' }
  if (pathname === '/admin/login') return { kind: 'pass' }
  if (!hasAdminSession) return { kind: 'redirect-login' }
  if (pathname === '/') return { kind: 'rewrite', path: '/admin' }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return { kind: 'pass' }
  return { kind: 'not-found' }
}
```

Modify `proxy.ts` — inside the `TENANCY_MODE === 'multi'` block, right after the `baseHost` check and before `parseTenantSlug`:

```ts
import { getIronSession } from 'iron-session'                      // already imported
import { adminSessionOptions, type AdminSessionData } from '@/lib/platform/admin-auth'
import { parseTenantSlug, getTenantBySlug } from '@/lib/platform/tenants'
import { decideTenantRouting, decideAdminRouting, isAdminHost } from '@/lib/platform/routing'
```

```ts
    if (isAdminHost(req.headers.get('host') ?? '', baseHost)) {
      const res = NextResponse.next({ request: { headers: requestHeaders } })
      const adminSession = await getIronSession<AdminSessionData>(req, res, adminSessionOptions)
      const decision = decideAdminRouting(pathname, adminSession.isPlatformAdmin === true)
      switch (decision.kind) {
        case 'pass': return res
        case 'redirect-login': return NextResponse.redirect(new URL('/admin/login', req.url))
        case 'rewrite': return NextResponse.rewrite(new URL(decision.path, req.url), { request: { headers: requestHeaders } })
        case 'not-found': return new NextResponse('Not found', { status: 404 })
      }
    }
```

And block the admin surface everywhere else in multi mode — after the admin branch, before the `not-tenant` handling, add:

```ts
    // The dashboard exists only on the admin host.
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return new NextResponse('Not found', { status: 404 })
    }
```

(Single mode: `/admin` requests fall through to the session redirect like any unknown path, and the pages themselves `notFound()` when `!isMultiTenant()` — Task 9.)

**Caution:** `@/lib/platform/admin-auth` imports `next/headers` (for `getAdminSession`) — importing the module in `proxy.ts` is fine (the proxy only touches `adminSessionOptions`), but verify `npm run build` keeps the proxy bundle happy; if the bundler complains about `next/headers` in the proxy context, split `adminSessionOptions` + `AdminSessionData` into `lib/platform/admin-session-options.ts` (dependency-free) and import from both places.

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: routing tests PASS; suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/platform/routing.ts lib/platform/routing.test.ts proxy.ts
git commit -m "feat(platform): admin-host routing (session-gated pages, / rewrite, off-host 404)"
```

---

### Task 9: Admin dashboard — overview lib + pages

**Files:**
- Create: `lib/platform/overview.ts`
- Create: `app/admin/login/page.tsx`
- Create: `app/admin/(protected)/layout.tsx`
- Create: `app/admin/(protected)/page.tsx`
- Create: `app/admin/(protected)/audit/page.tsx`
- Create: `components/admin/AdminLoginForm.tsx`, `components/admin/AdminNav.tsx`, `components/admin/ImpersonateButton.tsx`
- Test: `lib/platform/overview.test.ts`

**Interfaces:**
- Consumes: `getAdminSession` (Task 6), `createImpersonationGrant` route (Task 7), registry schema.
- Produces:

```ts
export interface TenantOverviewRow {
  tenant: Tenant
  lastActivityAt: string | null   // tenant created_at columns are TEXT datetime('now') strings
  reachable: boolean
}
export async function tenantOverview(opts?: {
  pdb?: PlatformDb
  nowMs?: number
  probe?: (t: Tenant) => Promise<string | null>
}): Promise<TenantOverviewRow[]>
export function clearOverviewCache(): void
```

- [ ] **Step 1: Write the failing test** — `lib/platform/overview.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { tenantOverview, clearOverviewCache } from './overview'

beforeEach(() => clearOverviewCache())

async function seed(pdb: Awaited<ReturnType<typeof createTestPlatformDb>>) {
  await pdb.insert(tenants).values([
    { slug: 'alpha', name: 'Alpha', dbUrl: 'file:alpha.db', status: 'active' },
    { slug: 'beta', name: 'Beta', dbUrl: 'file:beta.db', status: 'past_due' },
  ])
}

test('collects per-tenant activity via the probe; failures mark unreachable', async () => {
  const pdb = await createTestPlatformDb()
  await seed(pdb)
  const rows = await tenantOverview({
    pdb,
    nowMs: 1,
    probe: async (t) => {
      if (t.slug === 'beta') throw new Error('connect ECONNREFUSED')
      return '2026-07-17 09:30:00'
    },
  })
  assert.equal(rows.length, 2)
  const alpha = rows.find(r => r.tenant.slug === 'alpha')!
  const beta = rows.find(r => r.tenant.slug === 'beta')!
  assert.deepEqual([alpha.lastActivityAt, alpha.reachable], ['2026-07-17 09:30:00', true])
  assert.deepEqual([beta.lastActivityAt, beta.reachable], [null, false])
})

test('caches for five minutes', async () => {
  const pdb = await createTestPlatformDb()
  await seed(pdb)
  let calls = 0
  const probe = async () => { calls++; return null }
  await tenantOverview({ pdb, nowMs: 0, probe })
  await tenantOverview({ pdb, nowMs: 4 * 60_000, probe })       // cache hit
  assert.equal(calls, 2)                                        // 2 tenants, probed once
  await tenantOverview({ pdb, nowMs: 6 * 60_000, probe })       // expired
  assert.equal(calls, 4)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 overview`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** `lib/platform/overview.ts`:

```ts
import { sql } from 'drizzle-orm'
import { asc } from 'drizzle-orm'
import { getTenantDbFor } from '@/lib/db'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, type Tenant } from './schema'

// The founders' tenant list (spec Phase 3): registry facts + a light probe
// into each tenant DB for "when did this shop last trade". The probe doubles
// as a reachability check — a tenant whose DB errors shows as unreachable,
// which is exactly the ops signal we want on this page.

export interface TenantOverviewRow {
  tenant: Tenant
  lastActivityAt: string | null   // TEXT datetime('now') convention in tenant DBs
  reachable: boolean
}

const CACHE_TTL_MS = 5 * 60_000
const CONCURRENCY = 5
let cache: { rows: TenantOverviewRow[]; at: number } | null = null

export function clearOverviewCache(): void { cache = null }

export async function tenantOverview(opts: {
  pdb?: PlatformDb
  nowMs?: number
  probe?: (t: Tenant) => Promise<string | null>
} = {}): Promise<TenantOverviewRow[]> {
  const nowMs = opts.nowMs ?? Date.now()
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.rows

  const pdb = opts.pdb ?? getPlatformDb()
  const probe = opts.probe ?? defaultProbe
  const all = await pdb.select().from(tenants).orderBy(asc(tenants.slug))

  const rows: TenantOverviewRow[] = []
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const chunk = all.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(chunk.map(t => probe(t)))
    settled.forEach((s, j) => {
      rows.push(s.status === 'fulfilled'
        ? { tenant: chunk[j], lastActivityAt: s.value, reachable: true }
        : { tenant: chunk[j], lastActivityAt: null, reachable: false })
    })
  }
  cache = { rows, at: nowMs }
  return rows
}

async function defaultProbe(t: Tenant): Promise<string | null> {
  const db = getTenantDbFor(String(t.id), t.dbUrl)
  const [r] = await db.all<{ s: string | null; b: string | null }>(sql`
    SELECT (SELECT max(created_at) FROM sales) AS s,
           (SELECT max(created_at) FROM buy_transactions) AS b`)
  if (!r) return null
  const latest = [r.s, r.b].filter((x): x is string => x != null).sort().at(-1)
  return latest ?? null
}
```

`components/admin/AdminLoginForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function AdminLoginForm() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/platform/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      window.location.assign('/admin')
      return
    }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Login failed')
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <div className="space-y-2">
        <Label htmlFor="admin-password">Platform admin password</Label>
        <Input
          id="admin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || password.length === 0} className="w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
```

`app/admin/login/page.tsx`:

```tsx
import { notFound, redirect } from 'next/navigation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession } from '@/lib/platform/admin-auth'
import { AdminLoginForm } from '@/components/admin/AdminLoginForm'

export default async function AdminLoginPage() {
  if (!isMultiTenant()) notFound()
  const session = await getAdminSession()
  if (session.isPlatformAdmin) redirect('/admin')
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background">
      <h1 className="text-xl font-semibold">Platform admin</h1>
      <AdminLoginForm />
    </div>
  )
}
```

`components/admin/AdminNav.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function AdminNav() {
  async function logout() {
    await fetch('/api/platform/admin/login', { method: 'DELETE' })
    window.location.assign('/admin/login')
  }
  return (
    <header className="border-b border-border">
      <div className="container mx-auto px-4 h-14 flex items-center gap-6">
        <span className="font-semibold">Platform admin</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/admin" className="hover:underline">Tenants</Link>
          <Link href="/admin/audit" className="hover:underline">Audit</Link>
        </nav>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={logout}>Log out</Button>
        </div>
      </div>
    </header>
  )
}
```

`app/admin/(protected)/layout.tsx`:

```tsx
import { notFound, redirect } from 'next/navigation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession } from '@/lib/platform/admin-auth'
import { AdminNav } from '@/components/admin/AdminNav'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!isMultiTenant()) notFound()
  const session = await getAdminSession()
  if (!session.isPlatformAdmin) redirect('/admin/login')
  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <main className="container mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
```

`components/admin/ImpersonateButton.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function ImpersonateButton({ tenantId }: { tenantId: number }) {
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    const res = await fetch('/api/platform/admin/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    })
    if (res.ok) {
      const { url } = await res.json()
      window.location.assign(url)   // shop host burns the one-time grant
      return
    }
    setBusy(false)
  }
  return (
    <Button variant="outline" size="sm" onClick={go} disabled={busy}>
      {busy ? 'Opening…' : 'Open shop'}
    </Button>
  )
}
```

`app/admin/(protected)/page.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { tenantOverview } from '@/lib/platform/overview'
import { tenantUrl } from '@/lib/platform/tenants'
import { ImpersonateButton } from '@/components/admin/ImpersonateButton'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default', trialing: 'secondary', past_due: 'destructive',
  suspended: 'destructive', cancelled: 'outline', paused: 'outline',
}

function formatWhen(dt: string | null): string {
  if (!dt) return '—'
  const d = new Date(dt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return dt
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export default async function AdminTenantsPage() {
  const rows = await tenantOverview()
  const baseHost = process.env.PLATFORM_BASE_HOST!
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.tenant.status] = (acc[r.tenant.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Tenants ({rows.length})</h1>
        {Object.entries(counts).map(([status, n]) => (
          <Badge key={status} variant={STATUS_VARIANT[status] ?? 'outline'}>{status}: {n}</Badge>
        ))}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shop</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Signed up</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>DB</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ tenant, lastActivityAt, reachable }) => (
              <TableRow key={tenant.id}>
                <TableCell>
                  <a className="hover:underline" href={tenantUrl(tenant.slug, baseHost)} target="_blank" rel="noreferrer">
                    <span className="font-medium">{tenant.name}</span>{' '}
                    <span className="text-muted-foreground">{tenant.slug}</span>
                  </a>
                </TableCell>
                <TableCell className="capitalize">{tenant.plan}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[tenant.status] ?? 'outline'}>{tenant.status}</Badge>
                </TableCell>
                <TableCell>{new Date(tenant.createdAt * 1000).toLocaleDateString('en-GB')}</TableCell>
                <TableCell>{formatWhen(lastActivityAt)}</TableCell>
                <TableCell>
                  {reachable
                    ? <span className="text-muted-foreground">ok</span>
                    : <Badge variant="destructive">unreachable</Badge>}
                </TableCell>
                <TableCell>
                  {tenant.stripeCustomerId
                    ? <a className="hover:underline" href={`https://dashboard.stripe.com/customers/${tenant.stripeCustomerId}`} target="_blank" rel="noreferrer">Stripe ↗</a>
                    : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell><ImpersonateButton tenantId={tenant.id} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm text-muted-foreground">
        Activity and reachability are probed live from each tenant DB and cached for 5 minutes.
      </p>
    </div>
  )
}
```

`app/admin/(protected)/audit/page.tsx`:

```tsx
import { desc, inArray } from 'drizzle-orm'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getPlatformDb } from '@/lib/platform/db'
import { platformAudit, tenants } from '@/lib/platform/schema'

export default async function AdminAuditPage() {
  const pdb = getPlatformDb()
  const rows = await pdb.select().from(platformAudit).orderBy(desc(platformAudit.id)).limit(200)
  const tenantIds = [...new Set(rows.map(r => r.tenantId).filter((x): x is number => x != null))]
  const slugById = new Map(
    tenantIds.length
      ? (await pdb.select().from(tenants).where(inArray(tenants.id, tenantIds))).map(t => [t.id, t.slug])
      : [],
  )
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Audit trail</h1>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (UTC)</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{new Date(r.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                <TableCell>{r.actor}</TableCell>
                <TableCell>{r.action}</TableCell>
                <TableCell>{r.tenantId != null ? (slugById.get(r.tenantId) ?? r.tenantId) : '—'}</TableCell>
                <TableCell className="text-muted-foreground">{r.detail ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests + guard**

Run: `npm test 2>&1 | tail -5`
Expected: overview tests PASS; `tenancy-guard` still green (admin pages import platform modules, never the `db` singleton, and never call bare `getSettings()`).

- [ ] **Step 5: Commit**

```bash
git add lib/platform/overview.ts lib/platform/overview.test.ts app/admin/ components/admin/
git commit -m "feat(platform): admin dashboard — tenant overview, audit trail, impersonate"
```

---

### Task 10: Rate limits on shop auth endpoints

DB-backed lockouts already throttle per-shop brute force; this adds cheap per-IP limits on the endpoints themselves (spec §3.9). The 429 path through `guarded()` + `rateLimit` is already covered by the admin-login route test (Task 6); these two wirings are the same three lines and stay test-free by design — the tenant-DB bootstrap needed to drive the full routes isn't worth the wiring it would test.

**Files:**
- Modify: `app/api/auth/owner/route.ts`
- Modify: `app/api/auth/staff-pin/route.ts`

- [ ] **Step 1: Wire the owner login limiter** — in `app/api/auth/owner/route.ts`, add imports and the check at the top of the `POST` handler (before `getTenantDb()`):

```ts
import { rateLimit } from '@/lib/platform/rate-limit'
import { DomainError } from '@/lib/domain/errors'
```

```ts
export const POST = guarded(async (req: NextRequest) => {
  // Per-IP endpoint limit; the per-shop DB lockout below is the real
  // brute-force guard. Generous enough for a shop full of typos.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`owner-login:${ip}`, 20, 10 * 60_000)) {
    throw new DomainError('RATE_LIMITED', 'Too many login attempts — try again in a few minutes')
  }
  const db = await getTenantDb()
  ...
```

- [ ] **Step 2: Wire the staff-PIN limiter** — same shape in `app/api/auth/staff-pin/route.ts`, key `staff-pin:${ip}`, limit **120** per 10 minutes (busy-shop PIN churn is legitimate traffic; the DB lockout handles guessing).

- [ ] **Step 3: Verify suite still green**

Run: `npm test 2>&1 | tail -3`
Expected: PASS (no behaviour change below the limits).

- [ ] **Step 4: Commit**

```bash
git add app/api/auth/owner/route.ts app/api/auth/staff-pin/route.ts
git commit -m "feat: per-IP rate limits on owner login and staff PIN endpoints"
```

---

### Task 11: Full-shop export — zip builder, route, settings card

**Files:**
- Create: `lib/export-all.ts`
- Create: `app/api/settings/full-export/route.ts`
- Create: `components/settings/DataExportCard.tsx`
- Modify: `app/(app)/settings/page.tsx` (one line)
- Test: `lib/export-all.test.ts`

**Interfaces:**
- Consumes: `listUserTables` (Task 4), `toCSV` from `@/lib/csv`.
- Produces:

```ts
export interface ExportManifest { exportedAt: string; tables: Record<string, number> }
export async function buildFullExport(db: Db, now?: Date): Promise<{ zip: Uint8Array; manifest: ExportManifest }>
```

- [ ] **Step 1: Install the dependency**

Run: `npm install fflate`

- [ ] **Step 2: Write the failing test** — `lib/export-all.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { unzipSync, strFromU8 } from 'fflate'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { buildFullExport } from './export-all'

test('exports one CSV per table plus a manifest, with formula injection defused', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.insert(cards).values({ id: 'c1', name: '=HYPERLINK("evil")', setName: 'Base', setNumber: '4/102' })

  const { zip, manifest } = await buildFullExport(db, new Date('2026-07-18T12:00:00Z'))
  const files = unzipSync(zip)

  assert.ok(files['manifest.json'])
  assert.ok(files['cards.csv'])
  assert.ok(files['settings.csv'])
  assert.ok(files['sales.csv'])

  const parsed = JSON.parse(strFromU8(files['manifest.json']))
  assert.equal(parsed.exportedAt, '2026-07-18T12:00:00.000Z')
  assert.equal(parsed.tables.cards, 1)
  assert.equal(parsed.tables.settings, 1)
  assert.equal(parsed.tables.cards, manifest.tables.cards)

  const cardsCsv = strFromU8(files['cards.csv'])
  assert.ok(cardsCsv.split('\r\n')[0].includes('name'))          // header row = column names
  assert.ok(cardsCsv.includes(`"'=HYPERLINK(""evil"")"`))        // lib/csv formula guard applied
})

test('empty tables still get a header-only CSV (schema is part of the export)', async () => {
  const db = await createTestDb()
  await seedBase(db)
  const { zip, manifest } = await buildFullExport(db)
  const files = unzipSync(zip)
  assert.equal(manifest.tables.refunds, 0)
  const refundsCsv = strFromU8(files['refunds.csv'])
  assert.ok(refundsCsv.length > 0)
  assert.equal(refundsCsv.split('\r\n').length, 1)   // header only
})
```

(Adjust the `cards` insert columns to the real schema shape if they differ — read `lib/db/schema.ts`, don't modify it.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 export-all`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement.** `lib/export-all.ts`:

```ts
import { sql } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { toCSV } from '@/lib/csv'
import { listUserTables } from '@/lib/db/dump'
import type { Db } from '@/lib/db'

// Full-shop data export (spec §3.10): one CSV per table + a manifest, zipped.
// This is the GDPR/offboarding artefact the DPA promises — and the answer to
// "what would make you trust a new platform with your shop data".

export interface ExportManifest {
  exportedAt: string
  tables: Record<string, number>
}

export async function buildFullExport(db: Db, now: Date = new Date()): Promise<{ zip: Uint8Array; manifest: ExportManifest }> {
  const tables = await listUserTables(db)
  const files: Record<string, Uint8Array> = {}
  const manifest: ExportManifest = { exportedAt: now.toISOString(), tables: {} }

  for (const table of tables) {
    const safe = table.replace(/'/g, "''")
    const cols = (await db.all<{ name: string }>(sql.raw(`SELECT name FROM pragma_table_info('${safe}')`))).map(c => c.name)
    const rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${table}" ORDER BY rowid`))
    const csv = toCSV(cols, rows.map(r => cols.map(c => csvValue(r[c]))))
    files[`${table}.csv`] = strToU8(csv)
    manifest.tables[table] = rows.length
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return { zip: zipSync(files), manifest }
}

function csvValue(v: unknown): string | number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v)).toString('base64')
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  return String(v)
}
```

`app/api/settings/full-export/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireOwnerOrAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { buildFullExport } from '@/lib/export-all'

export const maxDuration = 120   // 20K-card catalogues take a few seconds to serialise

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireOwnerOrAdmin(await getSession(await currentTenantId()))
  const { zip } = await buildFullExport(db)
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="shop-data-${date}.zip"`,
    },
  })
})
```

`components/settings/DataExportCard.tsx`:

```tsx
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function DataExportCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data export</CardTitle>
        <CardDescription>
          Download everything — one CSV per table plus a manifest. This is the full
          GDPR/offboarding export; inventory and sales also have focused exports on their pages.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <a href="/api/settings/full-export" download>Download full export</a>
        </Button>
      </CardContent>
    </Card>
  )
}
```

(Server component — no hooks, no client directive needed. Match `BillingCard.tsx`'s Card import shape; if `CardDescription` isn't exported there, use a `<p className="text-sm text-muted-foreground">`.)

`app/(app)/settings/page.tsx` — add the import and one line after `<StaffSection />`:

```tsx
import { DataExportCard } from '@/components/settings/DataExportCard'
...
      <StaffSection />
      <DataExportCard />
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: export tests PASS; suite green.

- [ ] **Step 6: Commit**

```bash
git add lib/export-all.ts lib/export-all.test.ts app/api/settings/full-export/ \
  components/settings/DataExportCard.tsx "app/(app)/settings/page.tsx" package.json package-lock.json
git commit -m "feat: full-shop zip export (GDPR/offboarding) from settings"
```

---

### Task 12: Observability — Sentry, PostHog, Crisp (env-gated, no-op defaults)

**Files:**
- Modify: `lib/observability.ts` (created as a stub in Task 3 — confirm final shape below)
- Modify: `lib/api.ts` (report unexpected errors)
- Create: `instrumentation.ts` (repo root)
- Create: `instrumentation-client.ts` (repo root)
- Create: `components/shared/CrispChat.tsx`
- Modify: `app/layout.tsx` (one line)
- Test: `lib/api.test.ts`, `lib/observability.test.ts`

- [ ] **Step 1: Install the dependency**

Run: `npm install posthog-js`

- [ ] **Step 2: Write the failing tests.** `lib/observability.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { captureException } from './observability'

test('captureException is a silent no-op without SENTRY_DSN', async () => {
  const orig = process.env.SENTRY_DSN
  delete process.env.SENTRY_DSN
  await assert.doesNotReject(captureException(new Error('boom')))
  if (orig !== undefined) process.env.SENTRY_DSN = orig
})
```

`lib/api.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert'
import { guarded } from './api'
import { DomainError } from './domain/errors'

test('guarded maps DomainError to its status and body', async () => {
  const handler = guarded(async () => { throw new DomainError('RATE_LIMITED', 'slow down') })
  const res = await handler()
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { error: 'slow down', code: 'RATE_LIMITED' })
})

test('guarded turns unexpected errors into a generic 500 (and does not leak the message)', async () => {
  const handler = guarded(async () => { throw new Error('secret internals') })
  const res = await handler()
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: 'Internal error' })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B2 -E "observability|guarded"`
Expected: `lib/api.test.ts` FAILS only if behaviour differs (it shouldn't — these lock in current behaviour before the edit); `observability` test passes already via the Task 3 stub. Both existing = fine; they're the safety net for the next step.

- [ ] **Step 4: Implement.** `lib/api.ts` — report unexpected errors through the seam:

```ts
import { NextResponse } from 'next/server'
import { toHttpError } from '@/lib/domain/errors'
import { captureException } from '@/lib/observability'

// Wraps a route handler: DomainErrors become their mapped JSON response,
// anything else is reported (Sentry, when configured) and becomes a
// generic 500.
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      const mapped = toHttpError(e)
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status })
      await captureException(e)
      console.error('Unhandled route error:', e)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
  }
}
```

`instrumentation.ts` (repo root):

```ts
import type { Instrumentation } from 'next'

// Server-side Sentry, env-gated (spec §3.9): without SENTRY_DSN nothing is
// imported and nothing runs — tests, e2e and single-tenant deploys stay
// SDK-free. Client init lives in instrumentation-client.ts.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.SENTRY_DSN) {
    const Sentry = await import('@sentry/nextjs')
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
    })
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.SENTRY_DSN) return
  const Sentry = await import('@sentry/nextjs')
  Sentry.captureRequestError(...args)
}
```

`instrumentation-client.ts` (repo root):

```ts
// Client-side observability, env-gated. NEXT_PUBLIC_* vars are inlined at
// build time, so with them unset these branches are dead code and neither
// SDK reaches the browser bundle.

type SentryClient = typeof import('@sentry/nextjs')
let sentry: SentryClient | null = null

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  import('@sentry/nextjs').then((S) => {
    S.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0'),
    })
    sentry = S
  }).catch(() => {})
}

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      // EU cloud by default — consistent with the platform's Frankfurt data residency.
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com',
      defaults: '2025-05-24',   // history-change pageviews for the app-router SPA
    })
  }).catch(() => {})
}

export function onRouterTransitionStart(url: string, navigationType: 'push' | 'replace' | 'traverse') {
  sentry?.captureRouterTransitionStart(url, navigationType)
}
```

(**Note:** if the installed `posthog-js` types reject `defaults`, use `capture_pageview: 'history_change'` instead — same effect, older option name.)

`components/shared/CrispChat.tsx`:

```tsx
'use client'

import { useEffect } from 'react'

declare global {
  interface Window { $crisp?: unknown[]; CRISP_WEBSITE_ID?: string }
}

// Support chat (spec §3.9), env-gated: no NEXT_PUBLIC_CRISP_WEBSITE_ID → no
// script, no widget, nothing rendered.
export function CrispChat() {
  useEffect(() => {
    const id = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID
    if (!id || document.getElementById('crisp-chat')) return
    window.$crisp = window.$crisp ?? []
    window.CRISP_WEBSITE_ID = id
    const script = document.createElement('script')
    script.id = 'crisp-chat'
    script.src = 'https://client.crisp.chat/l.js'
    script.async = true
    document.head.appendChild(script)
  }, [])
  return null
}
```

`app/layout.tsx` — import and add one line next to the Toaster:

```tsx
import { CrispChat } from "@/components/shared/CrispChat";
...
        <Toaster theme="dark" />
        <CrispChat />
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: PASS — `guarded` behaviour unchanged for DomainErrors and 500s.

- [ ] **Step 6: Commit**

```bash
git add lib/observability.ts lib/observability.test.ts lib/api.ts lib/api.test.ts \
  instrumentation.ts instrumentation-client.ts components/shared/CrispChat.tsx app/layout.tsx \
  package.json package-lock.json
git commit -m "feat: env-gated Sentry/PostHog/Crisp with no-op defaults"
```

---

### Task 13: Runbooks + AGENTS.md

**Files:**
- Create: `docs/runbooks/platform-ops-setup.md`
- Create: `docs/runbooks/backup-restore-drill.md`
- Modify: `AGENTS.md` (extend the Multi-tenancy section, ~5 lines)

- [ ] **Step 1: Write `docs/runbooks/platform-ops-setup.md`** — full env-var reference. Content:

````markdown
# Runbook: platform ops setup (Phase 3)

Everything in Phase 3 is env-gated with a no-op default: an unset var means
the feature is off and nothing breaks. Set vars on the **platform** Vercel
project (all environments unless noted). Single-tenant (Wizard-of-Oz)
deploys need none of these except, optionally, the backup token.

## Environment variables

| Var | Feature | Value |
|---|---|---|
| `PLATFORM_ADMIN_PASSWORD_HASH` | admin dashboard login | bcrypt hash — generate: `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'your-password'` |
| `SENTRY_DSN` | server error reporting | DSN from sentry.io project settings |
| `NEXT_PUBLIC_SENTRY_DSN` | browser error reporting | same DSN value |
| `SENTRY_ENVIRONMENT` | optional | defaults to the Vercel env name |
| `SENTRY_TRACES_SAMPLE_RATE` | optional perf tracing | e.g. `0.1`; default `0` (errors only) |
| `NEXT_PUBLIC_POSTHOG_KEY` | product analytics | PostHog project API key (**EU cloud project**) |
| `NEXT_PUBLIC_POSTHOG_HOST` | optional | default `https://eu.i.posthog.com` |
| `NEXT_PUBLIC_CRISP_WEBSITE_ID` | support chat widget | Crisp website ID (Settings → Setup instructions) |
| `BLOB_READ_WRITE_TOKEN` | backup cron | create a **private** Blob store on the Vercel project; token is auto-added |
| `BACKUP_RETENTION_DAYS` | optional | default `14` |

Already required since Phases 1–2 (unchanged): `TENANCY_MODE`,
`PLATFORM_BASE_HOST`, `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN`,
`TURSO_GROUP_AUTH_TOKEN`, `TURSO_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`,
`SESSION_SECRET`, `CRON_SECRET`, Stripe + Resend vars
(see stripe-billing-setup.md).

## Registry migration

Phase 3 adds registry migration `0002_impersonation-grants.sql`. Apply to the
live platform DB before deploying:

```bash
env -u TURSO_DATABASE_URL -u TURSO_AUTH_TOKEN npx drizzle-kit migrate --config drizzle-platform.config.ts
```

(`PLATFORM_DATABASE_URL`/`PLATFORM_AUTH_TOKEN` must point at the live registry.)

## Crons (vercel.json — already committed)

| Path | Schedule | What |
|---|---|---|
| `/api/cron/sync-prices` | daily 03:00 | single-tenant deploys only; no-ops green in multi |
| `/api/cron/sync-tenants` | every 15 min | multi: price-syncs tenants due (>20h), oldest first, 240s budget |
| `/api/cron/backup-tenants` | hourly at :30 | dumps tenants due (>20h) to Blob; prunes past retention |

Sub-daily schedules need Vercel Pro. All three send `Authorization: Bearer
$CRON_SECRET` automatically (Vercel injects it when the env var exists).

## Admin dashboard

- `https://admin.<PLATFORM_BASE_HOST>` → tenant list (billing status, plan,
  last activity probed live from each tenant DB, reachability, Stripe link),
  `/admin/audit` → the platform_audit trail.
- **Impersonation**: "Open shop" mints a single-use 60-second grant, audited
  at both ends (`impersonate_grant` / `impersonate_login`). The session is
  owner-level named "Platform support" (4h cookie). It cannot ring sales or
  buys — staff-attributed writes fail on purpose. Log out via the shop's
  normal logout when done.
- Locally: add `127.0.0.1 admin.localhost` is unnecessary — browsers resolve
  `*.localhost` automatically; visit `http://admin.localhost:3000` with
  `TENANCY_MODE=multi`.

## Rate limits (fixed-window, per instance)

| Endpoint | Limit |
|---|---|
| signup | 5 / 10 min / IP (Phase 2) |
| setup token page | 10 / 10 min / IP (Phase 2) |
| owner login | 20 / 10 min / IP |
| staff PIN | 120 / 10 min / IP (DB lockout remains the brute-force guard) |
| admin login | 10 / 10 min / IP |
| impersonation consume | 10 / 10 min / IP |

The Stripe webhook is deliberately unlimited: it is signature-verified and
rate-limiting it would drop billing lifecycle events.

## Adopting the Wizard-of-Oz beta shops

Per shop (see also wizard-of-oz-shop-deploy.md "Adopting into the platform
later"): the shop's Turso DB already is a valid tenant DB —

```bash
npx tsx scripts/create-tenant.ts --slug <shop> --name "<Shop Name>" \
  --db-url libsql://<their-db-hostname> --skip-migrations
```

Then point `<shop>.<PLATFORM_BASE_HOST>` DNS at the platform deployment and
retire the per-shop Vercel project. The first backup and price sync happen
automatically within a cycle (no sync-state row needed — missing rows count
as most-overdue).
````

Verify the `create-tenant.ts` flag names against the actual script before committing (it predates this plan; use its real CLI shape).

- [ ] **Step 2: Write `docs/runbooks/backup-restore-drill.md`**:

````markdown
# Runbook: backups & the monthly restore drill

## What exists

- **Primary restore**: Turso point-in-time recovery (30 days on the paid plan).
- **Belt-and-braces**: `/api/cron/backup-tenants` (hourly) writes a gzipped
  logical SQL dump of every live tenant DB that hasn't been dumped in >20h to
  the Vercel Blob store under `backups/<slug>/<timestamp>.sql.gz`
  (single-tenant deploys: `backups/single-tenant/`). Retention
  `BACKUP_RETENTION_DAYS` (default 14). Dumps are provider-independent: they
  restore into any empty SQLite/libsql database.

## Monthly restore drill (~15 minutes)

Do this on the first Monday of each month. The point is proving the dumps
restore — an untested backup is a hope, not a backup.

1. Download the newest dump for one real tenant from the Vercel dashboard
   (Storage → Blob → `backups/<slug>/`).
2. Restore it into a fresh local file:
   ```bash
   npx tsx scripts/restore-backup.ts ~/Downloads/<timestamp>.sql.gz file:./drill.db
   ```
   The script refuses non-empty targets and prints per-table row counts.
3. Compare the printed counts against the live shop (admin dashboard tenant
   row, or ad-hoc queries). Counts for append-mostly tables (sales, buys,
   credit_ledger) must be ≤ live and close; a large gap means backups are
   stale — check `tenant_sync_state.last_backup_at` and the cron logs.
4. Boot the app against the restored copy and click through inventory, a
   customer, and a report:
   ```bash
   TURSO_DATABASE_URL=file:./drill.db npm run dev
   ```
5. Record the drill in the log below. Delete `drill.db*`.

**Pass** = restore completes, counts plausible, app browses cleanly.
**Fail** = anything else → treat as a P1 ops issue: fix the pipeline before
the next backup window, and verify Turso PITR works as the interim.

## Drill log

| Date | Tenant | Backup key | Result | Notes |
|---|---|---|---|---|
| _(add rows as drills run)_ | | | | |
````

- [ ] **Step 3: Extend `AGENTS.md`** — append to the Multi-tenancy section:

```markdown
- Phase 3 ops: admin dashboard on `admin.<base>` (env `PLATFORM_ADMIN_PASSWORD_HASH`,
  audited impersonation via single-use grants); cursor-staggered crons
  `sync-tenants` (15-min) + `backup-tenants` (hourly) built on
  `lib/platform/fanout.ts`; full-shop zip export at `/api/settings/full-export`;
  Sentry/PostHog/Crisp are env-gated no-ops by default. Setup + env vars:
  `docs/runbooks/platform-ops-setup.md`; backups/restore:
  `docs/runbooks/backup-restore-drill.md`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/platform-ops-setup.md docs/runbooks/backup-restore-drill.md AGENTS.md
git commit -m "docs: platform ops setup + backup restore drill runbooks"
```

---

### Task 14: Full verification + PR

- [ ] **Step 1: Full test suite** — `npm test` → all green (expect ~270+ tests).
- [ ] **Step 2: Lint** — `npm run lint` → clean.
- [ ] **Step 3: Production build** — `npm run build` → compiles (validates instrumentation files, admin pages, proxy imports, `@vercel/blob` private access typing).
- [ ] **Step 4: e2e** — `npm run test:e2e` → the single-mode checkout smoke still passes (proxy PUBLIC_PATHS and layout changes must not disturb it).
- [ ] **Step 5: Multi-mode manual smoke** (local, file-backed registry per the Phase 2 runbook): create a tenant with `scripts/create-tenant.ts`, set `PLATFORM_ADMIN_PASSWORD_HASH`, then — admin login at `http://admin.localhost:3000`, tenant visible with status/activity, impersonate lands in the shop as "Platform support", audit page shows both rows, `curl` the three cron routes with the secret, full export downloads from the shop settings page.
- [ ] **Step 6: Self-review the diff** against the ownership split (no `lib/db/schema.ts`, no tenant migrations, no `lib/domain/` changes; shared-file edits within the agreed one-to-three lines).
- [ ] **Step 7: Push and open the PR** to `main` titled "Platform Phase 3: ops — admin dashboard, staggered crons, backups, rate limits, export, observability", body: scope mapping to the spec list, deviations/shared-file touches, user-side steps (env vars, registry migration 0002, Blob store, beta-shop adoption, restore drill).

---

## Self-review notes (spec coverage)

- Admin dashboard w/ tenant list, billing status, last activity, impersonation + audit → Tasks 1, 6, 7, 8, 9.
- Sync-cron fan-out w/ cursor staggering (Phase 1 deferral) → Tasks 2, 3.
- Backup cron + restore drill → Tasks 4, 5, 13.
- Rate limits on public/auth endpoints → Tasks 6, 7 (new endpoints), 10 (existing).
- Full-shop export → Task 11.
- Sentry/PostHog/Crisp env-gated w/ runbook → Tasks 12, 13.
- Beta-shop adoption → documented user-side (Task 13 runbook); registry rows are a founder action by design.
- Out of scope, deliberately: tenant deletion automation (spec §3.10's export-window flow — needs a decided policy), `/api/health` extensions (exists since Phase 0), Stripe webhook durable-claim rework (billing.ts's noted residual risk — separate concern, touches Phase 2 code the other session may be near).
