import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireOwnerOrAdmin, requireTransactingStaff, type SessionData } from './auth'
import { DomainError } from './domain/errors'

const domainCode = (code: string) => (e: unknown) =>
  e instanceof DomainError && e.code === code

test('requireOwnerOrAdmin passes an owner session with no staff PIN', () => {
  const session: SessionData = { isOwnerLoggedIn: true }
  assert.equal(requireOwnerOrAdmin(session), session)
})

test('requireOwnerOrAdmin passes an admin PIN session', () => {
  const session: SessionData = { isOwnerLoggedIn: false, staffId: 1, staffRole: 'admin', staffName: 'Ann' }
  assert.equal(requireOwnerOrAdmin(session), session)
})

test('requireOwnerOrAdmin rejects a plain staff session', () => {
  const session: SessionData = { isOwnerLoggedIn: false, staffId: 2, staffRole: 'staff', staffName: 'Bob' }
  assert.throws(() => requireOwnerOrAdmin(session), domainCode('UNAUTHORIZED'))
})

test('requireOwnerOrAdmin rejects an empty session', () => {
  assert.throws(() => requireOwnerOrAdmin({ isOwnerLoggedIn: false }), domainCode('UNAUTHORIZED'))
})

test('requireTransactingStaff passes a real staff PIN session', () => {
  const session: SessionData = { isOwnerLoggedIn: false, staffId: 2, staffRole: 'staff', staffName: 'Bob' }
  assert.equal(requireTransactingStaff(session), session)
})

test('requireTransactingStaff rejects a session with no staff PIN', () => {
  assert.throws(() => requireTransactingStaff({ isOwnerLoggedIn: true }), domainCode('UNAUTHORIZED'))
})

test('requireTransactingStaff rejects an impersonated support session', () => {
  // The shape /api/auth/impersonate mints: owner-level, synthetic staffId -1.
  const session: SessionData = {
    isOwnerLoggedIn: true, staffId: -1, staffRole: 'admin',
    staffName: 'Platform support', impersonated: true,
  }
  assert.throws(() => requireTransactingStaff(session), domainCode('FORBIDDEN'))
})
