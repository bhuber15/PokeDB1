import { test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { createTestPlatformDb } from './test-helpers'
import { tenants } from './schema'
import { migrateTenantFleet } from './fleet-migrate'

type Pdb = Awaited<ReturnType<typeof createTestPlatformDb>>

const tempPaths: { path: string; dir?: boolean }[] = []
process.on('exit', () => {
  for (const { path, dir } of tempPaths) {
    try {
      if (dir) rmSync(path, { recursive: true })
      else unlinkSync(path)
    } catch { /* ignore */ }
  }
})

// Two-entry fixture journal so the tests stay hermetic — independent of
// whatever the real journal's newest migration happens to be.
const FIXTURE = [
  { tag: '0000_first', when: 1000, sql: 'CREATE TABLE t1 (id integer primary key);' },
  { tag: '0001_second', when: 2000, sql: 'CREATE TABLE t2 (id integer primary key);' },
]

function writeFixtureFolder(): string {
  const folder = join(tmpdir(), `fleet-fixture-${randomBytes(8).toString('hex')}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  tempPaths.push({ path: folder, dir: true })
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
    version: '7', dialect: 'sqlite',
    entries: FIXTURE.map((e, idx) => ({ idx, version: '6', when: e.when, tag: e.tag, breakpoints: true })),
  }))
  for (const e of FIXTURE) writeFileSync(join(folder, `${e.tag}.sql`), e.sql)
  return folder
}

function tempTenantDb(): { dbUrl: string; client: Client } {
  const path = join(tmpdir(), `fleet-tenant-${randomBytes(8).toString('hex')}.db`)
  for (const suffix of ['', '-wal', '-shm']) tempPaths.push({ path: path + suffix })
  return { dbUrl: `file:${path}`, client: createClient({ url: `file:${path}` }) }
}

async function registerTenant(pdb: Pdb, slug: string, dbUrl: string) {
  await pdb.insert(tenants).values({ slug, name: slug, dbUrl, status: 'active' })
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const r = await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE name = ?", args: [name] })
  return r.rows.length > 0
}

test('applies only the migrations a tenant is missing', async () => {
  const pdb = await createTestPlatformDb()
  const folder = writeFixtureFolder()
  const { dbUrl, client } = tempTenantDb()
  // Tenant sits at fixture head-minus-one: 0000 applied and bookkept.
  await client.execute(FIXTURE[0].sql)
  await client.execute('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
  await client.execute({
    sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
    args: ['whatever', FIXTURE[0].when],
  })
  await registerTenant(pdb, 'shop', dbUrl)

  const results = await migrateTenantFleet(pdb, { migrationsFolder: folder })
  assert.deepEqual(results, [{ slug: 'shop', ok: true, applied: 1 }])
  assert.ok(await tableExists(client, 't2'), 'pending migration ran')

  // Re-running is a no-op — the whole point of incremental bookkeeping.
  const again = await migrateTenantFleet(pdb, { migrationsFolder: folder })
  assert.deepEqual(again, [{ slug: 'shop', ok: true, applied: 0 }])
  client.close()
})

test('refuses a DB without bookkeeping rather than guessing its position', async () => {
  const pdb = await createTestPlatformDb()
  const folder = writeFixtureFolder()
  const { dbUrl, client } = tempTenantDb()
  await registerTenant(pdb, 'legacy', dbUrl)

  const results = await migrateTenantFleet(pdb, { migrationsFolder: folder })
  assert.equal(results[0].ok, false)
  assert.match(results[0].error!, /--assume-current/)
  assert.ok(!(await tableExists(client, 't1')), 'nothing was applied')
  client.close()
})

test('assumeCurrent seeds bookkeeping once, then the fleet is incremental', async () => {
  const pdb = await createTestPlatformDb()
  const folder = writeFixtureFolder()
  const { dbUrl, client } = tempTenantDb()
  await registerTenant(pdb, 'adopted', dbUrl)

  const seeded = await migrateTenantFleet(pdb, { migrationsFolder: folder, assumeCurrent: true })
  assert.deepEqual(seeded, [{ slug: 'adopted', ok: true, applied: 0, seeded: true }])
  const rows = await client.execute('SELECT count(*) AS n FROM __drizzle_migrations')
  assert.equal(Number(rows.rows[0].n), FIXTURE.length)

  const after = await migrateTenantFleet(pdb, { migrationsFolder: folder })
  assert.deepEqual(after, [{ slug: 'adopted', ok: true, applied: 0 }])
  client.close()
})

test('one broken tenant does not stop the rest of the fleet', async () => {
  const pdb = await createTestPlatformDb()
  const folder = writeFixtureFolder()
  await registerTenant(pdb, 'aa-broken', 'file:/nonexistent-dir/nope.db')
  const good = tempTenantDb()
  await good.client.execute('SELECT 1') // touch the file so it exists
  await registerTenant(pdb, 'bb-good', good.dbUrl)

  const results = await migrateTenantFleet(pdb, { migrationsFolder: folder, assumeCurrent: true })
  assert.equal(results.length, 2)
  assert.equal(results[0].slug, 'aa-broken')
  assert.equal(results[0].ok, false)
  assert.deepEqual(results[1], { slug: 'bb-good', ok: true, applied: 0, seeded: true })
  good.client.close()
})
