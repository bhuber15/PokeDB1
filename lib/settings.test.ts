import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, seedBase } from './db/test-helpers'
import { getSettings } from './settings'

test('getSettings never exposes ownerPasswordHash', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  const s = await getSettings(dbc)
  assert.ok(!('ownerPasswordHash' in s))
})
