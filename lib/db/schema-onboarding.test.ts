import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb } from './test-helpers'
import { settings } from './schema'

test('settings.onboarding column round-trips JSON and defaults to null', async () => {
  const db = await createTestDb()
  await db.insert(settings).values({ id: 1, shopName: 'Test Shop' })
  const [before] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(before.onboarding, null)
  await db.update(settings).set({ onboarding: '{"done":["settings"]}' }).where(eq(settings.id, 1))
  const [after] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(after.onboarding, '{"done":["settings"]}')
})
