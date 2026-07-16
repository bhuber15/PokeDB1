import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@libsql/client'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'db', 'migrations')

// Apply every migration in journal order. Used by tests, the e2e global
// setup, scripts/create-tenant.ts — and, since Phase 2, by provisioning at
// runtime (a new tenant DB is migrated from empty on signup).
export async function applyMigrations(client: Client): Promise<void> {
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
}
