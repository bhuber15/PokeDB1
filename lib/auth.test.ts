import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireOwnerOrAdmin, type SessionData } from './auth'
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
