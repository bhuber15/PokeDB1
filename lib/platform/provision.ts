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
