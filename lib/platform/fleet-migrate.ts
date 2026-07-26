import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { asc } from 'drizzle-orm'
import { recordMigrationBookkeeping } from '@/lib/db/migrate'
import type { PlatformDb } from './db'
import { tenants } from './schema'

// Deploy-time fleet migration (scripts/migrate-tenants.ts): deploys never
// auto-migrate, so after a deploy that added a migration every tenant DB is
// behind the code until this runs. Uses drizzle's incremental migrator —
// each DB applies only the journal entries newer than its
// __drizzle_migrations bookkeeping, so re-running is always safe.
//
// A DB *without* bookkeeping predates applyMigrations recording it; its
// journal position is unknowable, so we refuse to guess. `assumeCurrent` is
// the one-time operator assertion ("this fleet is at the current schema")
// that seeds the bookkeeping; from then on it migrates incrementally.

const MIGRATIONS_FOLDER = join(process.cwd(), 'lib', 'db', 'migrations')

export interface TenantMigrateResult {
  slug: string
  ok: boolean
  applied: number
  seeded?: boolean
  error?: string
}

export interface FleetMigrateOpts {
  connect?: (dbUrl: string) => Client
  assumeCurrent?: boolean
  migrationsFolder?: string
}

function defaultConnect(dbUrl: string): Client {
  return createClient({
    url: dbUrl,
    authToken: dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined,
  })
}

// Bookkeeping row count, or null when the table doesn't exist yet.
async function appliedCount(client: Client): Promise<number | null> {
  try {
    const r = await client.execute('SELECT count(*) AS applied FROM __drizzle_migrations')
    return Number(r.rows[0]?.applied ?? 0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('no such table')) return null
    throw err
  }
}

export async function migrateTenantFleet(
  pdb: PlatformDb, opts: FleetMigrateOpts = {},
): Promise<TenantMigrateResult[]> {
  const connect = opts.connect ?? defaultConnect
  const folder = opts.migrationsFolder ?? MIGRATIONS_FOLDER
  // Every status on purpose: a suspended shop that reactivates must not come
  // back schema-stale.
  const fleet = await pdb.select().from(tenants).orderBy(asc(tenants.slug))
  const results: TenantMigrateResult[] = []
  for (const tenant of fleet) {
    let client: Client | undefined
    try {
      client = connect(tenant.dbUrl) // can itself throw (bad URL) — must not stop the fleet
      const before = await appliedCount(client)
      if (before === null) {
        if (!opts.assumeCurrent) {
          results.push({
            slug: tenant.slug, ok: false, applied: 0,
            error: 'no __drizzle_migrations bookkeeping — if this shop is known to be at the current schema, rerun with --assume-current to adopt it',
          })
          continue
        }
        await recordMigrationBookkeeping(client, folder)
        results.push({ slug: tenant.slug, ok: true, applied: 0, seeded: true })
        continue
      }
      await migrate(drizzle(client), { migrationsFolder: folder })
      const after = (await appliedCount(client)) ?? before
      results.push({ slug: tenant.slug, ok: true, applied: after - before })
    } catch (err) {
      results.push({
        slug: tenant.slug, ok: false, applied: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      client?.close()
    }
  }
  return results
}
