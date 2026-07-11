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
