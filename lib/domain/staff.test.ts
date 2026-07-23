import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { createStaff, updateStaff, listStaff, getOwnerPasswordHash, setOwnerPasswordHash, assertStaffSeatAvailable } from './staff'
import { DomainError } from './errors'
import type { Db } from '../db'

let dbc: Db

const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

beforeEach(async () => {
  dbc = await createTestDb()
  // Two admins so most tests can freely mutate one without tripping the
  // last-admin guard; individual tests narrow this where needed.
  await createStaff({ name: 'Ann', pin: '1111', role: 'admin' }, dbc)
  await createStaff({ name: 'Bob', pin: '2222', role: 'admin' }, dbc)
})

test('createStaff hashes the pin and never returns it', async () => {
  const member = await createStaff({ name: 'Cara', pin: '3333', role: 'staff' }, dbc)
  assert.equal(member.name, 'Cara')
  assert.equal(member.role, 'staff')
  assert.equal(member.isActive, true)
  assert.equal('pinHash' in member, false)
  const [row] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, member.id))
  assert.notEqual(row.pinHash, '3333')
  assert.equal(await bcrypt.compare('3333', row.pinHash), true)
})

test('createStaff defaults role to staff', async () => {
  const member = await createStaff({ name: 'Dee', pin: '4444' }, dbc)
  assert.equal(member.role, 'staff')
})

test('listStaff returns summaries without pin hashes, ordered by name', async () => {
  const members = await listStaff(dbc)
  assert.deepEqual(members.map(m => m.name), ['Ann', 'Bob'])
  assert.equal(members.every(m => !('pinHash' in m)), true)
})

test('updateStaff can rename and change role', async () => {
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  const updated = await updateStaff(ann.id, { name: 'Annette', role: 'staff' }, dbc)
  assert.equal(updated.name, 'Annette')
  assert.equal(updated.role, 'staff')
})

test('updateStaff re-hashes the pin when provided', async () => {
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  await updateStaff(ann.id, { pin: '9999' }, dbc)
  const [row] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, ann.id))
  assert.equal(await bcrypt.compare('9999', row.pinHash), true)
  assert.equal(await bcrypt.compare('1111', row.pinHash), false)
})

test('deactivating a staff member is allowed and does not delete the row', async () => {
  const staffMember = await createStaff({ name: 'Eve', pin: '5555', role: 'staff' }, dbc)
  const updated = await updateStaff(staffMember.id, { isActive: false }, dbc)
  assert.equal(updated.isActive, false)
  const [row] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, staffMember.id))
  assert.equal(row.isActive, false)
})

test('cannot deactivate the last active admin', async () => {
  const [bob] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Bob'))
  await updateStaff(bob.id, { isActive: false }, dbc) // now Ann is the only active admin
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  await assert.rejects(
    updateStaff(ann.id, { isActive: false }, dbc),
    domainCode('FORBIDDEN'),
  )
  const [row] = await dbc.select().from(schema.staff).where(eq(schema.staff.id, ann.id))
  assert.equal(row.isActive, true) // rolled back, still active
})

test('cannot demote the last active admin to staff', async () => {
  const [bob] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Bob'))
  await updateStaff(bob.id, { isActive: false }, dbc)
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  await assert.rejects(
    updateStaff(ann.id, { role: 'staff' }, dbc),
    domainCode('FORBIDDEN'),
  )
})

test('demoting an admin is allowed while another active admin remains', async () => {
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  const updated = await updateStaff(ann.id, { role: 'staff' }, dbc)
  assert.equal(updated.role, 'staff') // Bob is still an active admin
})

test('a deactivated admin does not count toward the active-admin floor', async () => {
  // Deactivate Bob, then a fresh (inactive) admin should not rescue Ann.
  const [bob] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Bob'))
  await updateStaff(bob.id, { isActive: false }, dbc)
  const inactiveAdmin = await createStaff({ name: 'Fay', pin: '6666', role: 'admin' }, dbc)
  await updateStaff(inactiveAdmin.id, { isActive: false }, dbc)
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  await assert.rejects(
    updateStaff(ann.id, { isActive: false }, dbc),
    domainCode('FORBIDDEN'),
  )
})

test('updateStaff on an unknown id throws NOT_FOUND', async () => {
  await assert.rejects(updateStaff(9999, { name: 'Ghost' }, dbc), domainCode('NOT_FOUND'))
})

test('updateStaff with no fields throws INVALID_INPUT', async () => {
  const [ann] = await dbc.select().from(schema.staff).where(eq(schema.staff.name, 'Ann'))
  await assert.rejects(updateStaff(ann.id, {}, dbc), domainCode('INVALID_INPUT'))
})

test('owner password hash: unset by default, settable, retrievable', async () => {
  const dbc2 = await createTestDb()
  await seedBase(dbc2)
  assert.equal(await getOwnerPasswordHash(dbc2), null)
  await setOwnerPasswordHash('$2b$10$fakehash', dbc2)
  assert.equal(await getOwnerPasswordHash(dbc2), '$2b$10$fakehash')
})

test('setOwnerPasswordHash creates the settings row on a fresh tenant DB with none', async () => {
  // No seedBase: simulates a brand-new tenant DB before anything has lazily
  // created the settings row (the state Phase 2's /setup flow will see).
  const dbc3 = await createTestDb()
  await setOwnerPasswordHash('$2b$10$freshtenanthash', dbc3)
  assert.equal(await getOwnerPasswordHash(dbc3), '$2b$10$freshtenanthash')
})

test('assertStaffSeatAvailable enforces the plan seat limit on active staff', async () => {
  const db = await createTestDb()
  await createStaff({ name: 'A', pin: '1111', role: 'admin' }, db)
  await createStaff({ name: 'B', pin: '2222' }, db)
  const twoSeats = { staffSeats: 2, listingSync: false, apiAccess: false, multiGame: false }
  await assert.rejects(() => assertStaffSeatAvailable(twoSeats, db), domainCode('PLAN_LIMIT'))
  // Deactivated staff free their seat; unlimited plans never block.
  const b = await listStaff(db).then(s => s.find(x => x.name === 'B')!)
  await updateStaff(b.id, { isActive: false }, db)
  await assertStaffSeatAvailable(twoSeats, db) // no throw
  await assertStaffSeatAvailable({ staffSeats: null, listingSync: true, apiAccess: true, multiGame: true }, db) // no throw
})

test('assertStaffSeatAvailable ignores no-op reactivations of already-active staff', async () => {
  const db = await createTestDb()
  const a = await createStaff({ name: 'A', pin: '1111', role: 'admin' }, db)
  await createStaff({ name: 'B', pin: '2222' }, db)
  const c = await createStaff({ name: 'C', pin: '3333' }, db)
  await updateStaff(c.id, { isActive: false }, db) // A + B active — at the 2-seat cap
  const twoSeats = { staffSeats: 2, listingSync: false, apiAccess: false, multiGame: false }
  // Re-sending isActive: true for an already-active member is not a seat transition.
  await assertStaffSeatAvailable(twoSeats, db, { reactivatingId: a.id }) // no throw
  // A genuinely deactivated member would consume a seat — still blocked at cap.
  await assert.rejects(
    () => assertStaffSeatAvailable(twoSeats, db, { reactivatingId: c.id }),
    domainCode('PLAN_LIMIT'),
  )
  // Unknown id: NOT_FOUND is updateStaff's job, not a misleading PLAN_LIMIT.
  await assertStaffSeatAvailable(twoSeats, db, { reactivatingId: 999 }) // no throw
})
