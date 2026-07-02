import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomBytes } from 'node:crypto'
import * as schema from './schema'
import type { Db } from './index'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

// Fresh in-memory database with every migration applied in journal order.
export async function createTestDb(): Promise<Db> {
  // Use file-based temp database to work around libsql :memory: + transaction bug
  const dbId = randomBytes(8).toString('hex')
  const dbPath = `file:/tmp/test-${dbId}.db`
  const client = createClient({ url: dbPath })

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] }
  for (const { tag } of journal.entries) {
    const migration = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.execute(trimmed)
    }
  }
  return drizzle(client, { schema })
}

// Minimal shared fixtures: one staff member, one card, the settings row
// (schema defaults: marginMultiplier 0.85, primaryPriceSource 'cardmarket').
export async function seedBase(dbc: Db): Promise<void> {
  await dbc.insert(schema.staff).values({ id: 1, name: 'Tess', pinHash: 'x', role: 'staff' })
  await dbc.insert(schema.cards).values({ id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102' })
  await dbc.insert(schema.settings).values({ id: 1 })
}
