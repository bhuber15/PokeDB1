import type { Client } from '@libsql/client'
import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'

// Portable logical dump of one tenant DB: CREATE statements from
// sqlite_master plus batched INSERT literals, joined with the repo's
// migration separator so restore replays statements without parsing SQL.
// Provider-agnostic on purpose (spec §3.9): the same code dumps :memory:
// test DBs, file: dev DBs and libsql: production DBs, and the output
// restores into any of them.

export const DUMP_STATEMENT_SEPARATOR = '\n--> statement-breakpoint\n'

// Runtime bookkeeping, not shop data.
const SKIP_TABLES = new Set(['sqlite_sequence', 'libsql_wasm_func_table', '_litestream_seq', '_litestream_lock'])

export async function listUserTables(db: Db): Promise<string[]> {
  const rows = await db.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`)
  return rows.map(r => r.name).filter(n => !SKIP_TABLES.has(n))
}

const INSERT_BATCH = 200   // keeps each statement well under SQLite's 1MB SQL limit

export async function dumpDatabaseSql(db: Db): Promise<string> {
  const objects = await db.all<{ name: string; type: string; sql: string | null }>(sql`
    SELECT name, type, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`)

  const tables = objects.filter(o => o.type === 'table' && !SKIP_TABLES.has(o.name))
  const statements: string[] = ['PRAGMA foreign_keys=OFF']

  for (const t of tables) statements.push(t.sql!)

  for (const t of tables) {
    const rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${t.name}"`))
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH)
      const cols = Object.keys(batch[0])
      const values = batch
        .map(r => `(${cols.map(c => sqlLiteral(r[c])).join(',')})`)
        .join(',\n')
      statements.push(`INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES\n${values}`)
    }
  }

  // Indexes and triggers after data: restore is faster and trigger side
  // effects can't fire during the INSERT replay.
  for (const o of objects) {
    if (o.type !== 'table' && !SKIP_TABLES.has(o.name)) statements.push(o.sql!)
  }

  return statements.join(DUMP_STATEMENT_SEPARATOR)
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof ArrayBuffer) return `X'${Buffer.from(new Uint8Array(v)).toString('hex')}'`
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

// Counterpart used by scripts/restore-backup.ts and the drill runbook.
export async function replaySqlDump(client: Client, dump: string): Promise<number> {
  let applied = 0
  for (const statement of dump.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) {
      await client.execute(trimmed)
      applied++
    }
  }
  return applied
}
