import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomBytes } from 'node:crypto'
import * as schema from './schema'
import type { PlatformDb } from './db'

const MIGRATIONS_DIR = join(process.cwd(), 'lib', 'platform', 'migrations')
const tempFiles: string[] = []

export async function applyPlatformMigrations(client: Client): Promise<void> {
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

process.on('exit', () => {
  for (const filePath of tempFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(filePath + suffix) } catch { /* ignore */ }
    }
  }
})

export async function createTestPlatformDb(): Promise<PlatformDb> {
  const dbPath = join(tmpdir(), `test-platform-${randomBytes(8).toString('hex')}.db`)
  tempFiles.push(dbPath)
  const client = createClient({ url: `file:${dbPath}` })
  await applyPlatformMigrations(client)
  return drizzle(client, { schema })
}
