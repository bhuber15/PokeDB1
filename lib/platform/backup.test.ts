import { test } from 'node:test'
import assert from 'node:assert'
import { gunzipSync } from 'node:zlib'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { replaySqlDump, listUserTables } from '@/lib/db/dump'
import * as schema from '@/lib/db/schema'
import { memoryBackupStore, getBackupStore } from './backup-store'
import { backupKey, backupKeyTime, backupDatabase, pruneBackups } from './backup'

test('getBackupStore is null without BLOB_READ_WRITE_TOKEN (feature off by default)', () => {
  const orig = process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.BLOB_READ_WRITE_TOKEN
  assert.equal(getBackupStore(), null)
  if (orig !== undefined) process.env.BLOB_READ_WRITE_TOKEN = orig
})

test('backupKey is date-stamped under the tenant prefix, and backupKeyTime parses it back', () => {
  const at = new Date('2026-07-18T03:30:00Z')
  const key = backupKey('brads-cards', at)
  assert.equal(key, 'backups/brads-cards/2026-07-18T03-30-00Z.sql.gz')
  assert.equal(backupKeyTime(key), Math.floor(at.getTime() / 1000))
  assert.equal(backupKeyTime('backups/x/not-a-stamp.sql.gz'), null)
})

test('backupDatabase writes a gzipped dump that restores', async () => {
  const db = await createTestDb()
  await seedBase(db)
  const store = memoryBackupStore()
  const { key, bytes } = await backupDatabase(store, 'shop-a', db, new Date('2026-07-18T03:00:00Z'))
  assert.ok(bytes > 0)
  const gz = store.objects.get(key)!
  const dump = gunzipSync(Buffer.from(gz)).toString('utf8')
  const restored = createClient({ url: ':memory:' })
  await replaySqlDump(restored, dump)
  const tables = await listUserTables(drizzle(restored, { schema }))
  assert.ok(tables.includes('settings'))
})

test('pruneBackups deletes only objects older than retention, per tenant', async () => {
  const store = memoryBackupStore()
  const now = new Date('2026-07-18T00:00:00Z')
  const old = new Date('2026-07-01T00:00:00Z')     // 17 days: prune at 14
  const fresh = new Date('2026-07-10T00:00:00Z')   // 8 days: keep
  await backupDatabase(store, 'shop-a', await createTestDb(), old)
  await backupDatabase(store, 'shop-a', await createTestDb(), fresh)
  await backupDatabase(store, 'shop-b', await createTestDb(), old)  // other tenant untouched
  const pruned = await pruneBackups(store, 'shop-a', 14, now)
  assert.equal(pruned, 1)
  const remaining = await store.list('backups/shop-a/')
  assert.equal(remaining.length, 1)
  assert.ok(remaining[0].key.includes('2026-07-10'))
  assert.equal((await store.list('backups/shop-b/')).length, 1)
})
