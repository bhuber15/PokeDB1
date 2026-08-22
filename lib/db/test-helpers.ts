import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { createHash, randomBytes } from 'node:crypto'
import * as schema from './schema'
import type { Db } from './index'
import { applyMigrations } from './migrate'

export { applyMigrations }

const tempFiles: string[] = []
const openClients: Client[] = []

// Close every client this worker opened once its test file finishes — libsql
// handles left open at worker exit can surface as one-off file-level 'test
// failed' noise with all subtests passing. Guarded: scripts (e2e seed) import
// this module outside the test runner, where node:test hooks must not run.
if (process.env.NODE_TEST_CONTEXT) {
  after(() => {
    for (const client of openClients) {
      try { client.close() } catch { /* already closed */ }
    }
  })
}

// Clean up temporary test database files on process exit
process.on('exit', () => {
  for (const filePath of tempFiles) {
    // Remove .db file and its associated WAL files
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(filePath + suffix)
      } catch {
        // Ignore missing files
      }
    }
  }
})

// Replaying every migration per createTestDb call cost ~1.8s of setup in each
// test process; copying a pre-migrated template file is milliseconds. The
// template is keyed by a hash of the migration journal + SQL, so any migration
// change rebuilds it from a real replay — the schema still only ever comes
// from migrations, just once per schema state instead of once per database.
// Templates live in node_modules/.cache (never committed, wiped by reinstalls).
const TEMPLATE_DIR = join(process.cwd(), 'node_modules', '.cache', 'pokedb-test-db')
const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

function migrationsHash(): string {
  const journal = readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
  const hash = createHash('sha256').update(journal)
  for (const { tag } of (JSON.parse(journal) as { entries: { tag: string }[] }).entries) {
    hash.update(readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`)))
  }
  return hash.digest('hex').slice(0, 16)
}

let templatePromise: Promise<string> | null = null
function ensureTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const target = join(TEMPLATE_DIR, `tenant-${migrationsHash()}.db`)
    if (existsSync(target)) return target
    mkdirSync(TEMPLATE_DIR, { recursive: true })
    const build = `${target}.build-${randomBytes(4).toString('hex')}`
    const client = createClient({ url: `file:${build}` })
    await applyMigrations(client)
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    client.close()
    if (existsSync(`${build}-wal`)) {
      throw new Error('test-db template has an unflushed WAL — refusing to cache a partial database')
    }
    // Atomic: concurrent test processes may race to build, but every builder
    // produces identical bytes, so whichever rename lands last is still right.
    renameSync(build, target)
    return target
  })()
  return templatePromise
}

// Fresh database with every migration applied in journal order (via the
// template above). Note: libsql :memory: databases cannot be used here because
// each connection (including transactions) gets its own empty database. Since
// drizzle transactions run on a separate connection, a transaction cannot see
// tables created by the migration statements. File-backed temp databases
// (cleaned up on process exit) are required for transaction isolation.
export async function createTestDb(): Promise<Db> {
  const dbId = randomBytes(8).toString('hex')
  const dbPath = join(tmpdir(), `test-${dbId}.db`)
  tempFiles.push(dbPath)
  copyFileSync(await ensureTemplate(), dbPath)
  const client = createClient({ url: `file:${dbPath}` })
  openClients.push(client)
  return drizzle(client, { schema })
}

// Minimal shared fixtures: one staff member, one card, the settings row
// (schema defaults: marginMultiplier 0.85, primaryPriceSource 'cardmarket').
export async function seedBase(dbc: Db): Promise<void> {
  await dbc.insert(schema.staff).values({ id: 1, name: 'Tess', pinHash: 'x', role: 'staff' })
  await dbc.insert(schema.cards).values({ id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102' })
  await dbc.insert(schema.settings).values({ id: 1 })
}
