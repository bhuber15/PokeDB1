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
