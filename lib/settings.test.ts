import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createTestDb, seedBase } from './db/test-helpers'
import { getSettings, updateSettings, DEFAULT_SETTINGS } from './settings'

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

test('condition ladder: defaults to all-100 and round-trips through updateSettings', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const before = await getSettings(dbc)
  assert.deepEqual(before.conditionSellPct, { NM: 100, LP: 100, MP: 100, HP: 100, DMG: 100 })

  const after = await updateSettings(
    { conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } }, dbc)
  assert.deepEqual(after.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })

  // Persisted, not just echoed
  const reread = await getSettings(dbc)
  assert.deepEqual(reread.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })

  // A ladder-less patch leaves the ladder untouched
  const patched = await updateSettings({ shopName: 'Cardtill' }, dbc)
  assert.deepEqual(patched.conditionSellPct, { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 })
})
