import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainError, toHttpError } from './errors'
import { requireOwner, requireStaff, requireAdmin, type SessionData } from '../auth'

// assert.throws/rejects predicates take `unknown` — narrow via instanceof
// (a `(e: DomainError) => …` param would violate strictFunctionTypes).
const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

test('toHttpError maps codes to statuses', () => {
  assert.equal(toHttpError(new DomainError('INVALID_INPUT', 'bad'))!.status, 400)
  assert.equal(toHttpError(new DomainError('UNAUTHORIZED', 'no'))!.status, 401)
  assert.equal(toHttpError(new DomainError('FORBIDDEN', 'no'))!.status, 403)
  assert.equal(toHttpError(new DomainError('NOT_FOUND', 'gone'))!.status, 404)
  for (const code of ['INSUFFICIENT_STOCK', 'PRICE_CHANGED', 'INSUFFICIENT_CREDIT', 'NO_PRICE', 'BAD_LINE'] as const) {
    assert.equal(toHttpError(new DomainError(code, 'conflict'))!.status, 409)
  }
})

test('toHttpError passes message, code and meta through; null for non-domain errors', () => {
  const mapped = toHttpError(new DomainError('INSUFFICIENT_STOCK', 'no stock', { inventoryItemId: 7 }))!
  assert.deepEqual(mapped.body, { error: 'no stock', code: 'INSUFFICIENT_STOCK', meta: { inventoryItemId: 7 } })
  assert.equal(toHttpError(new Error('boom')), null)
  assert.equal(toHttpError('boom'), null)
})

test('requireStaff / requireAdmin / requireOwner', () => {
  const anon: SessionData = { isOwnerLoggedIn: false }
  const ownerOnly: SessionData = { isOwnerLoggedIn: true }
  const staff: SessionData = { isOwnerLoggedIn: true, staffId: 2, staffRole: 'staff' }
  const admin: SessionData = { isOwnerLoggedIn: true, staffId: 1, staffRole: 'admin' }

  assert.equal(requireOwner(ownerOnly), ownerOnly)
  assert.throws(() => requireOwner(anon), domainCode('UNAUTHORIZED'))

  assert.equal(requireStaff(staff).staffId, 2)
  assert.throws(() => requireStaff(ownerOnly), domainCode('UNAUTHORIZED'))

  assert.equal(requireAdmin(admin).staffId, 1)
  // Deliberate tightening: a device-unlocked owner cookie alone no longer
  // satisfies admin checks — an admin PIN session is required.
  assert.throws(() => requireAdmin(ownerOnly), domainCode('UNAUTHORIZED'))
  assert.throws(() => requireAdmin(staff), domainCode('FORBIDDEN'))
})
