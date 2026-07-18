# Runbook: backups & the monthly restore drill

## What exists

- **Primary restore**: Turso point-in-time recovery (30 days on the paid plan).
- **Belt-and-braces**: `/api/cron/backup-tenants` (hourly) writes a gzipped
  logical SQL dump of every live tenant DB that hasn't been dumped in >20h to
  the Vercel Blob store under `backups/<slug>/<timestamp>.sql.gz`
  (single-tenant deploys: `backups/single-tenant/`). Retention
  `BACKUP_RETENTION_DAYS` (default 14). Dumps are provider-independent: they
  restore into any empty SQLite/libsql database.

## Monthly restore drill (~15 minutes)

Do this on the first Monday of each month. The point is proving the dumps
restore — an untested backup is a hope, not a backup.

1. Download the newest dump for one real tenant from the Vercel dashboard
   (Storage → Blob → `backups/<slug>/`).
2. Restore it into a fresh local file:
   ```bash
   npx tsx scripts/restore-backup.ts ~/Downloads/<timestamp>.sql.gz file:./drill.db
   ```
   The script refuses non-empty targets and prints per-table row counts.
3. Compare the printed counts against the live shop (admin dashboard tenant
   row, or ad-hoc queries). Counts for append-mostly tables (sales, buys,
   credit_ledger) must be ≤ live and close; a large gap means backups are
   stale — check `tenant_sync_state.last_backup_at` and the cron logs.
4. Boot the app against the restored copy and click through inventory, a
   customer, and a report:
   ```bash
   TURSO_DATABASE_URL=file:./drill.db npm run dev
   ```
5. Record the drill in the log below. Delete `drill.db*`.

**Pass** = restore completes, counts plausible, app browses cleanly.
**Fail** = anything else → treat as a P1 ops issue: fix the pipeline before
the next backup window, and verify Turso PITR works as the interim.

## Drill log

| Date | Tenant | Backup key | Result | Notes |
|---|---|---|---|---|
| _(add rows as drills run)_ | | | | |
