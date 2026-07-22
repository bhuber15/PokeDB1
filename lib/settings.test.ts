import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createTestDb, seedBase } from './db/test-helpers'
import { getSettings, DEFAULT_SETTINGS } from './settings'

test('getSettings never exposes ownerPasswordHash', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const s = await getSettings(dbc)
  assert.ok(!('ownerPasswordHash' in s))
})

// Single-tenant: a broken DB degrades to defaults so pricing never crashes.
// Multi-tenant: the same failure must reject — see the paired test below.
const originalMode = process.env.TENANCY_MODE
afterEach(() => {
  if (originalMode === undefined) delete process.env.TENANCY_MODE
  else process.env.TENANCY_MODE = originalMode
})

test('single mode: getSettings swallows a broken DB and returns defaults', async () => {
  delete process.env.TENANCY_MODE
  const dbc = await createTestDb()
  await dbc.run(sql`DROP TABLE settings`)
  const s = await getSettings(dbc)
  assert.deepEqual(s, DEFAULT_SETTINGS)
})

test('multi mode: getSettings rejects on a broken DB instead of returning defaults', async () => {
  process.env.TENANCY_MODE = 'multi'
  const dbc = await createTestDb()
  await dbc.run(sql`DROP TABLE settings`)
  await assert.rejects(() => getSettings(dbc))
})

test('enabledLanguages defaults to EN and round-trips through updateSettings', async () => {
  const db = await createTestDb()
  const initial = await getSettings(db)
  assert.deepEqual(initial.enabledLanguages, ['EN'])

  const { updateSettings } = await import('./settings')
  const updated = await updateSettings({ enabledLanguages: ['EN', 'JA', 'KO'] }, db)
  assert.deepEqual(updated.enabledLanguages, ['EN', 'JA', 'KO'])
  assert.deepEqual((await getSettings(db)).enabledLanguages, ['EN', 'JA', 'KO'])
})

test('malformed enabled_languages JSON degrades to [EN], never throws', async () => {
  const db = await createTestDb()
  await getSettings(db) // create the row
  await db.run(sql`UPDATE settings SET enabled_languages = 'not json' WHERE id = 1`)
  assert.deepEqual((await getSettings(db)).enabledLanguages, ['EN'])
})
