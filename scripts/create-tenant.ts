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
import { applyMigrations } from '../lib/db/migrate'
import { applyPlatformMigrations } from '../lib/platform/test-helpers'
import { RESERVED_SLUGS, TENANT_SLUG_RE } from '../lib/platform/tenants'
import * as tenantSchema from '../lib/db/schema'
import * as platformSchema from '../lib/platform/schema'

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'db-url': { type: 'string' },
    'skip-migrations': { type: 'boolean' },
  },
})

async function main() {
  const { slug, name } = values
  const dbUrl = values['db-url']
  if (!slug || !name || !dbUrl) {
    console.error('Required: --slug --name --db-url')
    process.exit(1)
  }
  if (!TENANT_SLUG_RE.test(slug)) {
    console.error('Slug must be lowercase letters/digits/hyphens, 3–40 chars')
    process.exit(1)
  }
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    console.error(`Slug '${slug}' is reserved (${RESERVED_SLUGS.join(', ')}) and cannot be used for a tenant`)
    process.exit(1)
  }

  const platformUrl = process.env.PLATFORM_DATABASE_URL
  if (!platformUrl) {
    console.error('PLATFORM_DATABASE_URL is required')
    process.exit(1)
  }

  // 1. Registry first: migrate (idempotent-ish for file DBs) + duplicate-slug
  // check, so a dupe fails cleanly before we touch any tenant DB.
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

  // 2. Tenant DB: migrate + seed settings (idempotent on re-run).
  const tenantClient = createClient({
    url: dbUrl,
    authToken: dbUrl.startsWith('libsql:') ? process.env.TURSO_GROUP_AUTH_TOKEN : undefined,
  })
  if (!values['skip-migrations']) {
    // Adopting an already-migrated DB (e.g. a Wizard-of-Oz shop)? Pass
    // --skip-migrations — the journal loop re-runs all statements and would
    // fail on existing tables.
    await applyMigrations(tenantClient)
  }
  const tdb = drizzle(tenantClient, { schema: tenantSchema })
  const existingSettings = await tdb.select().from(tenantSchema.settings).limit(1)
  if (existingSettings.length === 0) {
    await tdb.insert(tenantSchema.settings).values({ id: 1, shopName: name })
  }
  const [row] = await pdb.insert(platformSchema.tenants)
    .values({ slug, name, dbUrl }).returning()
  console.log(`Tenant '${slug}' registered with id ${row.id} → ${dbUrl}`)
  console.log(`Serve it locally: TENANCY_MODE=multi PLATFORM_BASE_HOST=localhost PLATFORM_DATABASE_URL=${platformUrl} npm run dev`)
  console.log(`Then visit http://${slug}.localhost:3000`)
}

main().catch(e => { console.error(e); process.exit(1) })
