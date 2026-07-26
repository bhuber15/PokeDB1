import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { applyMigrations } from './migrate'

// The bookkeeping applyMigrations records must be exactly what drizzle's own
// migrator expects, or the first incremental migration on a provisioned
// tenant (scripts/migrate-tenants.ts, drizzle-kit migrate) replays the whole
// journal and dies on the first duplicate statement.
test('applyMigrations leaves a DB drizzle can migrate incrementally', async () => {
  const client = createClient({ url: ':memory:' })
  await applyMigrations(client)

  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'lib', 'db', 'migrations', 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] }
  const rows = await client.execute('SELECT count(*) AS n FROM __drizzle_migrations')
  assert.equal(Number(rows.rows[0].n), journal.entries.length)

  // Drizzle's migrator sees the DB at head: no-op, no duplicate-table crash.
  await migrate(drizzle(client), { migrationsFolder: join(process.cwd(), 'lib', 'db', 'migrations') })
  const after = await client.execute('SELECT count(*) AS n FROM __drizzle_migrations')
  assert.equal(Number(after.rows[0].n), journal.entries.length)
  client.close()
})
