import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb, getTenantDbFor, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'
import { forEachDueTenant } from '@/lib/platform/fanout'
import { getBackupStore } from '@/lib/platform/backup-store'
import { backupDatabase, pruneBackups, BACKUP_DUE_AFTER_S } from '@/lib/platform/backup'
import { captureException } from '@/lib/observability'

// Hourly; each invocation backs up tenants whose last dump is >20h old, so
// the fleet is covered daily and a missed hour self-heals. Single-tenant
// deployments (Wizard-of-Oz beta shops) get the same protection for their
// one DB under backups/single-tenant/.
export const maxDuration = 300
const BUDGET_MS = 240_000

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret there is no valid Authorization
  // header, so an unset CRON_SECRET can never be matched by `Bearer undefined`.
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const store = getBackupStore()
  if (!store) return NextResponse.json({ skipped: 'no-blob-token' })
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? '14')

  if (!isMultiTenant()) {
    const result = await backupDatabase(store, 'single-tenant', await getTenantDb())
    const pruned = await pruneBackups(store, 'single-tenant', retentionDays)
    return NextResponse.json({ ...result, pruned })
  }

  const result = await forEachDueTenant(
    { pdb: getPlatformDb(), field: 'lastBackupAt', dueAfterSeconds: BACKUP_DUE_AFTER_S, budgetMs: BUDGET_MS },
    async (tenant) => {
      await backupDatabase(store, tenant.slug, getTenantDbFor(String(tenant.id), tenant.dbUrl))
      await pruneBackups(store, tenant.slug, retentionDays)
    },
  )
  for (const p of result.processed) {
    if (!p.ok) await captureException(new Error(`backup failed for ${p.slug}: ${p.error}`))
  }
  return NextResponse.json(result)
}
