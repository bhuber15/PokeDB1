import { sql } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { toCSV } from '@/lib/csv'
import { listUserTables } from '@/lib/db/dump'
import type { Db } from '@/lib/db'

// Full-shop data export (spec §3.10): one CSV per table + a manifest, zipped.
// This is the GDPR/offboarding artefact the DPA promises — and the answer to
// "what would make you trust a new platform with your shop data".

export interface ExportManifest {
  exportedAt: string
  tables: Record<string, number>
}

export async function buildFullExport(db: Db, now: Date = new Date()): Promise<{ zip: Uint8Array; manifest: ExportManifest }> {
  const tables = await listUserTables(db)
  const files: Record<string, Uint8Array> = {}
  const manifest: ExportManifest = { exportedAt: now.toISOString(), tables: {} }

  for (const table of tables) {
    const safe = table.replace(/'/g, "''")
    const cols = (await db.all<{ name: string }>(sql.raw(`SELECT name FROM pragma_table_info('${safe}')`))).map(c => c.name)
    const rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${table}" ORDER BY rowid`))
    const csv = toCSV(cols, rows.map(r => cols.map(c => csvValue(r[c]))))
    files[`${table}.csv`] = strToU8(csv)
    manifest.tables[table] = rows.length
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return { zip: zipSync(files), manifest }
}

function csvValue(v: unknown): string | number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v)).toString('base64')
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  return String(v)
}
