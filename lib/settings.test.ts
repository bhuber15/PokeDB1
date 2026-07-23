import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { createTestDb, seedBase } from './db/test-helpers'
import { getSettings, updateSettings, DEFAULT_SETTINGS, settingsPatchSchema } from './settings'

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

test('settingsPatchSchema: enabledLanguages validates codes and always includes EN', () => {
  const ok = settingsPatchSchema.safeParse({ enabledLanguages: ['JA', 'KO'] })
  assert.ok(ok.success)
  assert.deepEqual(ok.data.enabledLanguages, ['EN', 'JA', 'KO'])
  assert.ok(!settingsPatchSchema.safeParse({ enabledLanguages: ['JA', 'xx'] }).success)
  assert.ok(!settingsPatchSchema.safeParse({ enabledLanguages: 'JA' }).success)
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

test('settingsPatchSchema: accepts a full 1–100 integer ladder', () => {
  const r = settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 85, MP: 70, HP: 50, DMG: 35 } })
  assert.ok(r.success)
})

test('settingsPatchSchema: rejects partial ladders, out-of-range and non-integer values', () => {
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 85 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 100, LP: 0, MP: 70, HP: 50, DMG: 35 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 101, LP: 85, MP: 70, HP: 50, DMG: 35 } }).success)
  assert.ok(!settingsPatchSchema.safeParse({ conditionSellPct: { NM: 99.5, LP: 85, MP: 70, HP: 50, DMG: 35 } }).success)
})

test('settingsPatchSchema: preserves the existing route semantics', () => {
  // valid single-field patches
  assert.ok(settingsPatchSchema.safeParse({ marginMultiplier: 0.9 }).success)
  assert.ok(settingsPatchSchema.safeParse({ buyCreditPct: 1 }).success)
  assert.ok(settingsPatchSchema.safeParse({ vatScheme: 'margin' }).success)
  // invalid values that the old route 400'd on
  assert.ok(!settingsPatchSchema.safeParse({ marginMultiplier: 0 }).success)
  assert.ok(!settingsPatchSchema.safeParse({ buyCashPct: 1.5 }).success)
  assert.ok(!settingsPatchSchema.safeParse({ primaryPriceSource: 'ebay' }).success)
  // empty patch → refine failure (was "No valid fields to update")
  assert.ok(!settingsPatchSchema.safeParse({}).success)
  // unknown keys are stripped, and a patch of ONLY unknown keys is empty → rejected
  assert.ok(!settingsPatchSchema.safeParse({ bogus: 1 }).success)
})
