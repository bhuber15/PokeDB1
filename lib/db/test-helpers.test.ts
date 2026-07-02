import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from './test-helpers'
import * as schema from './schema'

test('createTestDb applies all migrations and supports inserts', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const [staffRow] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, 1))
  assert.equal(staffRow.name, 'Tess')
  const [card] = await dbc.select().from(schema.cards).where(eq(schema.cards.id, 1))
  assert.equal(card.name, 'Pikachu')
  // refunds table only exists if the latest migrations ran
  const rows = await dbc.select().from(schema.refunds)
  assert.deepEqual(rows, [])
})

test('two test dbs are isolated', async () => {
  const a = await createTestDb()
  const b = await createTestDb()
  await seedBase(a)
  assert.deepEqual(await b.select().from(schema.staff), [])
})
