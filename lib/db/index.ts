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
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
    warnOnMigrationDrift(client)
    _singleton = drizzle(client, { schema })
  }
  return _singleton
}

// Warn (never migrate) when the DB is missing migrations this code expects.
// Deploys and merges don't auto-migrate, so the code routinely lands ahead of
// the DB; the symptom is a silent one — getSettings() swallows the resulting
// "no such column" and serves DEFAULT_SETTINGS, so the shop quietly loses its
// saved margins, VAT scheme and enabled games rather than erroring.
// Dev only: unit tests run on :memory: and e2e runs NODE_ENV=test — both
// build their schema fresh per run, so there is no drift to catch there.
// globalThis guard = once per process across dev-server module re-evaluation.
//
// The import is dynamic and inside the dev branch on purpose: migration-drift
// reads the journal off disk, and a static import puts node:fs into the module
// graph of everything that imports lib/db — which 404s the app's pages under
// Turbopack (same failure mode as pulling lib/domain into a client component).
function warnOnMigrationDrift(client: ReturnType<typeof createClient>): void {
  const g = globalThis as typeof globalThis & { __migrationDriftChecked?: boolean }
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.TURSO_DATABASE_URL !== ':memory:' &&
    !g.__migrationDriftChecked
  ) {
    g.__migrationDriftChecked = true
    void import('./migration-drift')
      .then(m => m.checkMigrationDrift(client))
      .catch(() => {}) // the check must never take the app down
  }
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
  // Keyed by id+url so a rotated tenant DB never serves a stale connection.
  const key = `${tenantId}:${dbUrl}`
  const existing = tenantDbs.get(key)
  if (existing) return existing
  const authToken = dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined
  const client = makeDb(dbUrl, authToken)
  tenantDbs.set(key, client)
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
