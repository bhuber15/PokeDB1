// Restore a backup dump into an EMPTY database. Part of the monthly restore
// drill — see docs/runbooks/backup-restore-drill.md.
//
//   npx tsx scripts/restore-backup.ts <dump.sql.gz> <target-db-url> [auth-token]
//
// e.g. npx tsx scripts/restore-backup.ts ./2026-07-18T03-30-00Z.sql.gz file:./drill.db
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createClient } from '@libsql/client'
import { replaySqlDump } from '../lib/db/dump'

async function main() {
  const [dumpPath, targetUrl, authToken] = process.argv.slice(2)
  if (!dumpPath || !targetUrl) {
    console.error('usage: npx tsx scripts/restore-backup.ts <dump.sql.gz> <target-db-url> [auth-token]')
    process.exit(1)
  }
  const raw = readFileSync(dumpPath)
  const dump = dumpPath.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')

  const client = createClient({ url: targetUrl, authToken })
  const existing = await client.execute(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  if (Number(existing.rows[0].n) > 0) {
    console.error(`Refusing to restore: target already has ${existing.rows[0].n} tables. Restore into an empty DB.`)
    process.exit(1)
  }

  const applied = await replaySqlDump(client, dump)
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  console.log(`Applied ${applied} statements. Restored tables:`)
  for (const row of tables.rows) {
    const n = await client.execute(`SELECT count(*) AS n FROM "${row.name}"`)
    console.log(`  ${row.name}: ${n.rows[0].n} rows`)
  }
  client.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
