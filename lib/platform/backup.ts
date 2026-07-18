import { gzipSync } from 'node:zlib'
import { dumpDatabaseSql } from '@/lib/db/dump'
import type { Db } from '@/lib/db'
import type { BackupStore } from './backup-store'

// Nightly-ish belt-and-braces dumps (spec §3.9): Turso PITR is the primary
// restore path; these gzipped logical dumps are the provider-independent
// artefact the monthly restore drill exercises
// (docs/runbooks/backup-restore-drill.md).

export const BACKUP_DUE_AFTER_S = 20 * 3600

export function backupKey(slug: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z'
  return `backups/${slug}/${stamp}.sql.gz`
}

// backups/<slug>/2026-07-18T03-30-00Z.sql.gz → epoch seconds (null if foreign).
// Retention is judged by the backup time embedded in the key, not the store's
// upload timestamp, so tests and re-uploads behave predictably.
export function backupKeyTime(key: string): number | null {
  const m = key.match(/\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sql\.gz$/)
  if (!m) return null
  return Math.floor(Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) / 1000)
}

export async function backupDatabase(
  store: BackupStore, slug: string, db: Db, now: Date = new Date(),
): Promise<{ key: string; bytes: number }> {
  const dump = await dumpDatabaseSql(db)
  const gz = gzipSync(Buffer.from(dump, 'utf8'))
  const key = backupKey(slug, now)
  await store.put(key, gz)
  return { key, bytes: gz.byteLength }
}

export async function pruneBackups(
  store: BackupStore, slug: string, retentionDays: number, now: Date = new Date(),
): Promise<number> {
  const cutoff = Math.floor(now.getTime() / 1000) - retentionDays * 86400
  const objects = await store.list(`backups/${slug}/`)
  const stale = objects.filter(o => (backupKeyTime(o.key) ?? o.uploadedAt) < cutoff)
  await store.del(stale.map(o => o.url))
  return stale.length
}
