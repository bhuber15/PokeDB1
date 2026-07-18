import { test } from 'node:test'
import assert from 'node:assert'
import { createClient } from '@libsql/client'
import { sql, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import * as schema from '@/lib/db/schema'
import { cards, customers } from '@/lib/db/schema'
import { listUserTables, dumpDatabaseSql, replaySqlDump } from './dump'

test('listUserTables sees the tenant schema and skips sqlite internals', async () => {
  const db = await createTestDb()
  const tables = await listUserTables(db)
  assert.ok(tables.includes('cards'))
  assert.ok(tables.includes('sales'))
  assert.ok(tables.includes('settings'))
  assert.ok(!tables.some(t => t.startsWith('sqlite_')))
})

test('dump → replay round-trips schema and data, including hostile strings', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.insert(cards).values({
    id: 2, name: "O'Malley's \"Pikachu\"\nline2", setName: '=EVIL()+1', setNumber: '1/1',
  })
  await db.insert(customers).values({ name: 'Ünïcødé 🃏', email: 'x@y.z' })

  const dump = await dumpDatabaseSql(db)
  const restored = createClient({ url: ':memory:' })
  const applied = await replaySqlDump(restored, dump)
  assert.ok(applied > 10, `expected many statements, got ${applied}`)

  const rdb = drizzle(restored, { schema })
  const sourceTables = await listUserTables(db)
  const restoredTables = await listUserTables(rdb)
  assert.deepEqual(restoredTables, sourceTables)

  for (const t of sourceTables) {
    const [a] = await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t}"`))
    const [b] = await rdb.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t}"`))
    assert.equal(b.n, a.n, `row count for ${t}`)
  }

  const [card] = await rdb.select().from(cards).where(eq(cards.id, 2))
  assert.equal(card.name, "O'Malley's \"Pikachu\"\nline2")
  assert.equal(card.setName, '=EVIL()+1')
  const [cust] = await rdb.select().from(customers)
  assert.equal(cust.name, 'Ünïcødé 🃏')
})

test('replaying a dump onto itself again fails loudly (no silent double-restore)', async () => {
  const db = await createTestDb()
  const dump = await dumpDatabaseSql(db)
  const restored = createClient({ url: ':memory:' })
  await replaySqlDump(restored, dump)
  await assert.rejects(replaySqlDump(restored, dump))   // CREATE TABLE already exists
})
