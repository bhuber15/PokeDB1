import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@libsql/client'

// Deploys and merges never auto-migrate the database, so the code can get
// ahead of the DB and routes then 500 with SQLite "no such column". This
// module detects that drift at dev boot by comparing the checked-in journal
// against drizzle-kit's bookkeeping table, and warns — it never migrates.

export type MigrationDrift =
  | { kind: 'in-sync' }
  | { kind: 'pending'; pending: string[] }
  | { kind: 'db-ahead'; journalCount: number; appliedCount: number }

// drizzle-kit applies migrations in journal order and appends one row per
// migration to __drizzle_migrations, so the first `appliedCount` journal
// entries are the applied ones and everything after them is pending.
export function compareMigrations(journalTags: string[], appliedCount: number): MigrationDrift {
  if (appliedCount > journalTags.length) {
    return { kind: 'db-ahead', journalCount: journalTags.length, appliedCount }
  }
  const pending = journalTags.slice(appliedCount)
  if (pending.length === 0) return { kind: 'in-sync' }
  return { kind: 'pending', pending }
}

export function formatDriftWarning(drift: MigrationDrift): string | null {
  if (drift.kind === 'in-sync') return null
  const bar = '▲'.repeat(74)
  if (drift.kind === 'db-ahead') {
    return [
      bar,
      `[migration-drift] DATABASE IS AHEAD OF THE CODE: ${drift.appliedCount} migrations`,
      `  applied but this checkout only knows ${drift.journalCount}. You are probably running`,
      '  an older branch against a newer database — pull/rebase before writing data.',
      bar,
    ].join('\n')
  }
  return [
    bar,
    `[migration-drift] DATABASE IS BEHIND THE CODE — ${drift.pending.length} migration(s) never applied:`,
    '',
    ...drift.pending.map((tag) => `    lib/db/migrations/${tag}.sql`),
    '',
    '  Routes touching the new tables/columns will 500 with "no such column".',
    '  Nothing auto-migrates. Fix: npx drizzle-kit migrate',
    '  (make sure shell TURSO_* vars are not overriding .env.local first)',
    bar,
  ].join('\n')
}

function readJournalTags(): string[] {
  const raw = readFileSync(
    join(process.cwd(), 'lib', 'db', 'migrations', 'meta', '_journal.json'),
    'utf8',
  )
  return (JSON.parse(raw) as { entries: { tag: string }[] }).entries.map((e) => e.tag)
}

// Fire-and-forget boot check. Must never throw or reject: a failure of the
// check itself (no network, bad creds, weird cwd) only logs a one-line note.
export async function checkMigrationDrift(client: Client, journalTags?: string[]): Promise<void> {
  try {
    const tags = journalTags ?? readJournalTags()
    let appliedCount = 0
    try {
      const result = await client.execute('SELECT count(*) AS applied FROM __drizzle_migrations')
      appliedCount = Number(result.rows[0]?.applied ?? 0)
    } catch (err) {
      // A database that has never been migrated has no bookkeeping table.
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('no such table')) throw err
    }
    const warning = formatDriftWarning(compareMigrations(tags, appliedCount))
    if (warning) console.warn(warning)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[migration-drift] check skipped (${message})`)
  }
}
