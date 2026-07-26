import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { checkMigrationDrift, compareMigrations, formatDriftWarning } from './migration-drift'

test('compareMigrations: equal counts are in sync', () => {
  assert.deepEqual(compareMigrations(['0000_a', '0001_b'], 2), { kind: 'in-sync' })
})

test('compareMigrations: empty journal and fresh DB are in sync', () => {
  assert.deepEqual(compareMigrations([], 0), { kind: 'in-sync' })
})

test('compareMigrations: names pending tags in journal order', () => {
  assert.deepEqual(compareMigrations(['0000_a', '0001_b', '0002_c'], 1), {
    kind: 'pending',
    pending: ['0001_b', '0002_c'],
  })
})

test('compareMigrations: never-migrated DB pends every migration', () => {
  assert.deepEqual(compareMigrations(['0000_a', '0001_b'], 0), {
    kind: 'pending',
    pending: ['0000_a', '0001_b'],
  })
})

test('compareMigrations: more applied than the journal knows means DB is ahead', () => {
  assert.deepEqual(compareMigrations(['0000_a'], 3), {
    kind: 'db-ahead',
    journalCount: 1,
    appliedCount: 3,
  })
})

test('formatDriftWarning: in sync produces no warning', () => {
  assert.equal(formatDriftWarning({ kind: 'in-sync' }), null)
})

test('formatDriftWarning: pending names each file and the fix command', () => {
  const warning = formatDriftWarning({ kind: 'pending', pending: ['0013_ambitious_mojo'] })
  assert.ok(warning)
  assert.match(warning, /lib\/db\/migrations\/0013_ambitious_mojo\.sql/)
  assert.match(warning, /npx drizzle-kit migrate/)
  assert.match(warning, /BEHIND THE CODE/)
})

test('formatDriftWarning: db-ahead names both counts', () => {
  const warning = formatDriftWarning({ kind: 'db-ahead', journalCount: 15, appliedCount: 16 })
  assert.ok(warning)
  assert.match(warning, /16 migrations/)
  assert.match(warning, /only knows 15/)
})

// Mimics the bookkeeping table drizzle-kit creates, with n applied rows.
async function clientWithApplied(n: number): Promise<Client> {
  const client = createClient({ url: ':memory:' })
  await client.execute(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
  for (let i = 0; i < n; i++) {
    await client.execute(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h${i}', ${i})`)
  }
  return client
}

test('checkMigrationDrift: stays quiet when applied count matches the journal', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const client = await clientWithApplied(2)
  await checkMigrationDrift(client, ['0000_a', '0001_b'])
  assert.equal(warn.mock.calls.length, 0)
  client.close()
})

test('checkMigrationDrift: warns loudly naming the pending files', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const client = await clientWithApplied(1)
  await checkMigrationDrift(client, ['0000_a', '0001_b', '0002_c'])
  assert.equal(warn.mock.calls.length, 1)
  const message = warn.mock.calls[0].arguments[0] as string
  assert.match(message, /2 migration\(s\) never applied/)
  assert.match(message, /0001_b\.sql/)
  assert.match(message, /0002_c\.sql/)
  assert.doesNotMatch(message, /0000_a\.sql/)
  client.close()
})

test('checkMigrationDrift: missing bookkeeping table counts as nothing applied', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const client = createClient({ url: ':memory:' })
  await checkMigrationDrift(client, ['0000_a'])
  assert.equal(warn.mock.calls.length, 1)
  assert.match(warn.mock.calls[0].arguments[0] as string, /1 migration\(s\) never applied/)
  client.close()
})

test('checkMigrationDrift: a broken client never throws, only logs a note', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const client = createClient({ url: ':memory:' })
  client.close()
  await checkMigrationDrift(client, ['0000_a'])
  assert.equal(warn.mock.calls.length, 1)
  const message = warn.mock.calls[0].arguments[0] as string
  assert.match(message, /^\[migration-drift\] check skipped/)
  assert.doesNotMatch(message, /BEHIND THE CODE/)
})

test('checkMigrationDrift: reads the checked-in journal by default', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'lib', 'db', 'migrations', 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] }
  const client = await clientWithApplied(journal.entries.length)
  await checkMigrationDrift(client)
  assert.equal(warn.mock.calls.length, 0)
  client.close()
})
