import { test } from 'node:test'
import assert from 'node:assert'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { settings, staff, inventoryItems, sales } from '@/lib/db/schema'
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
  assert.deepEqual(s.steps, [], 'dismissed is terminal — no steps, no live counts')
})

test('a fully completed checklist persists completedAt and stops counting', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.update(settings).set({ onboarding: '{}' }).where(eq(settings.id, 1))

  // Complete every step: manual settings mark, a second staff member,
  // 5 inventory items and 1 sale.
  await markOnboardingStep('settings', db)
  await db.insert(staff).values({ name: 'Second', pinHash: 'x', role: 'staff' })
  await db.insert(inventoryItems).values(
    Array.from({ length: 5 }, (_, i) => ({ cardId: 1, condition: 'NM', quantity: 1, qrCode: `ONB-${i + 1}` })),
  )
  await db.insert(sales).values({ subtotal: 500, total: 500, paymentMethod: 'cash' })

  // First call computes all four steps done and persists the terminal mark.
  let s = await getOnboarding(db)
  assert.equal(s.enabled, true)
  assert.deepEqual(s.steps.map(x => x.done), [true, true, true, true])
  const [row] = await db.select().from(settings).where(eq(settings.id, 1))
  assert.ok(JSON.parse(row.onboarding!).completedAt, 'completedAt persisted on full completion')

  // Every later call short-circuits: no steps, none of the three counts run.
  s = await getOnboarding(db)
  assert.deepEqual(s.steps, [])
  assert.ok(s.dismissedAt, 'completedAt doubles as the hide signal')
})

test('malformed stored JSON is treated as enabled with nothing recorded', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.update(settings).set({ onboarding: 'not json' }).where(eq(settings.id, 1))
  const s = await getOnboarding(db)
  assert.equal(s.enabled, true)
  assert.equal(s.dismissedAt, null)
  assert.equal(s.steps.length, 4)
})
