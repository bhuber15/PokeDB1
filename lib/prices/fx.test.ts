import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from '@/lib/db/test-helpers'
import { getSettings, updateSettings } from '@/lib/settings'
import { refreshFxRates } from '@/lib/prices/fx'
import { FrankfurterError } from '@/lib/apis/frankfurter'

test('a successful fetch persists the new rates into settings', async () => {
  const db = await createTestDb()
  const result = await refreshFxRates(db, async () => ({ usd: 0.7872, eur: 0.8657 }))
  assert.deepEqual(result, { updated: true, usd: 0.7872, eur: 0.8657 })
  const after = await getSettings(db)
  assert.equal(after.usdToGbp, 0.7872)
  assert.equal(after.eurToGbp, 0.8657)
})

test('a failed fetch keeps the stored rates and reports the reason — never blocks the sync', async () => {
  const db = await createTestDb()
  await updateSettings({ usdToGbp: 0.81, eurToGbp: 0.88 }, db)
  const result = await refreshFxRates(db, async () => { throw new FrankfurterError('Frankfurter 503') })
  assert.equal(result.updated, false)
  assert.equal(result.error, 'Frankfurter 503')
  const after = await getSettings(db)
  assert.equal(after.usdToGbp, 0.81) // untouched
  assert.equal(after.eurToGbp, 0.88)
})

test('unchanged rates skip the settings write', async () => {
  const db = await createTestDb()
  const before = await getSettings(db)
  const result = await refreshFxRates(db, async () => ({ usd: before.usdToGbp, eur: before.eurToGbp }))
  assert.equal(result.updated, false)
  assert.equal(result.error, undefined)
})
