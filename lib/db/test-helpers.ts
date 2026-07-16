import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomBytes } from 'node:crypto'
import * as schema from './schema'
import type { Db } from './index'
import { applyMigrations } from './migrate'

export { applyMigrations }

const tempFiles: string[] = []

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

// Fresh database with every migration applied in journal order.
// Note: libsql :memory: databases cannot be used here because each connection
// (including transactions) gets its own empty database. Since drizzle transactions
// run on a separate connection, a transaction cannot see tables created by the
// migration statements. File-backed temp databases (cleaned up on process exit)
// are required to ensure transaction isolation works correctly.
export async function createTestDb(): Promise<Db> {
  const dbId = randomBytes(8).toString('hex')
  const dbPath = join(tmpdir(), `test-${dbId}.db`)
  const dbUrl = `file:${dbPath}`
  tempFiles.push(dbPath)
  const client = createClient({ url: dbUrl })
  await applyMigrations(client)
  return drizzle(client, { schema })
}

// Minimal shared fixtures: one staff member, one card, the settings row
// (schema defaults: marginMultiplier 0.85, primaryPriceSource 'cardmarket').
export async function seedBase(dbc: Db): Promise<void> {
  await dbc.insert(schema.staff).values({ id: 1, name: 'Tess', pinHash: 'x', role: 'staff' })
  await dbc.insert(schema.cards).values({ id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102' })
  await dbc.insert(schema.settings).values({ id: 1 })
}
