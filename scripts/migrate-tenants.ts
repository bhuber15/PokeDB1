// Apply pending tenant-schema migrations to every shop in the platform
// registry. Deploys never auto-migrate, so run this after every deploy that
// added a migration — a code-ahead DB 500s with "no such column" until then.
// Incremental via each DB's __drizzle_migrations bookkeeping; always safe to
// re-run.
//
// Usage:
//   npx tsx scripts/migrate-tenants.ts
//   npx tsx scripts/migrate-tenants.ts --assume-current   # one-time adoption of
//     DBs provisioned before bookkeeping existed (asserts they are at head)
import './load-env'
import { parseArgs } from 'node:util'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrateTenantFleet } from '../lib/platform/fleet-migrate'
import * as platformSchema from '../lib/platform/schema'

const { values } = parseArgs({ options: { 'assume-current': { type: 'boolean' } } })

async function main() {
  const platformUrl = process.env.PLATFORM_DATABASE_URL
  if (!platformUrl) {
    console.error('PLATFORM_DATABASE_URL is required')
    process.exit(1)
  }
  const pdb = drizzle(
    createClient({ url: platformUrl, authToken: process.env.PLATFORM_AUTH_TOKEN }),
    { schema: platformSchema },
  )
  const results = await migrateTenantFleet(pdb, { assumeCurrent: values['assume-current'] })
  if (results.length === 0) console.log('No tenants registered — nothing to migrate.')
  for (const r of results) {
    if (!r.ok) console.error(`✗ ${r.slug}: ${r.error}`)
    else if (r.seeded) console.log(`✓ ${r.slug}: bookkeeping seeded (assumed at current schema)`)
    else console.log(`✓ ${r.slug}: ${r.applied === 0 ? 'up to date' : `applied ${r.applied} migration(s)`}`)
  }
  const failed = results.filter(r => !r.ok)
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} tenant(s) failed — fix and re-run (completed tenants no-op).`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
