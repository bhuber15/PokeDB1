import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { settings, staff } from '@/lib/db/schema'
import { getOnboarding, markOnboardingStep, dismissOnboarding } from './onboarding'

test('onboarding is disabled when the settings column is null (adopted shops)', async () => {
  const db = await createTestDb()
  await seedBase(db) // settings row with onboarding = null
  const s = await getOnboarding(db)
  assert.equal(s.enabled, false)
  await markOnboardingStep('settings', db) // must be a harmless no-op
  const [row] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.equal(row.onboarding, null)
})

test('computes steps from data and stores manual marks + dismissal', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.update(settings).set({ onboarding: '{}' }).where(eq(settings.id, 1))

  let s = await getOnboarding(db)
  assert.equal(s.enabled, true)
  assert.equal(s.dismissedAt, null)
  assert.deepEqual(s.steps, [
    { id: 'settings', done: false },
    { id: 'inventory', done: false }, // 0 items < 5
    { id: 'sale', done: false },      // 0 sales
    { id: 'staff', done: false },     // 1 member (the setup admin) < 2
  ])

  await markOnboardingStep('settings', db)
  await db.insert(staff).values({ name: 'Second', pinHash: 'x', role: 'staff' })
  s = await getOnboarding(db)
  assert.deepEqual(s.steps.filter(x => x.done).map(x => x.id), ['settings', 'staff'])

  await dismissOnboarding(db)
  s = await getOnboarding(db)
  assert.ok(s.dismissedAt)
})
