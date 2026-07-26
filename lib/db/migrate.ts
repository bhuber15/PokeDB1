import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

function readJournal(migrationsFolder: string): { tag: string; when: number }[] {
  return (JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] }).entries
}

// Apply every migration in journal order. Used by tests, the e2e global
// setup, scripts/create-tenant.ts — and, since Phase 2, by provisioning at
// runtime (a new tenant DB is migrated from empty on signup).
export async function applyMigrations(client: Client): Promise<void> {
  for (const { tag } of readJournal(MIGRATIONS_DIR)) {
    const migration = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.execute(trimmed)
    }
  }
  await recordMigrationBookkeeping(client)
}

// Write the __drizzle_migrations rows drizzle's own migrator would have
// written (same DDL, same sha256-of-file hash, created_at = journal `when`),
// declaring the DB to be at this journal's head. Called after applyMigrations
// completes — when that is true by construction — so every DB we create can
// later be migrated *incrementally* by drizzle-kit or
// scripts/migrate-tenants.ts instead of only ever from empty.
export async function recordMigrationBookkeeping(
  client: Client, migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  await client.batch([
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    'DELETE FROM "__drizzle_migrations"',
    ...readJournal(migrationsFolder).map(({ tag, when }) => ({
      sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
      args: [
        createHash('sha256').update(readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8')).digest('hex'),
        when,
      ],
    })),
  ])
}
