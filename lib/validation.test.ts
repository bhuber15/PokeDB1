import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { parseBody, parseIdParam } from './validation'
import { DomainError } from './domain/errors'

const schema = z.object({
  name: z.string().min(1),
  quantity: z.number().int(),
})

function jsonRequest(body: string): Request {
  return new Request('http://test.local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

test('parseBody returns validated data', async () => {
  const data = await parseBody(jsonRequest('{"name":"Pikachu","quantity":2}'), schema)
  assert.deepEqual(data, { name: 'Pikachu', quantity: 2 })
})

test('parseBody strips unknown keys', async () => {
  const data = await parseBody(jsonRequest('{"name":"Pikachu","quantity":2,"isAdmin":true}'), schema)
  assert.deepEqual(data, { name: 'Pikachu', quantity: 2 })
})

test('parseBody rejects malformed JSON with INVALID_INPUT', async () => {
  await assert.rejects(
    parseBody(jsonRequest('not json{'), schema),
    (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT' && e.message === 'Invalid JSON body',
  )
})

test('parseBody rejects wrong types with the field path in the message', async () => {
  await assert.rejects(
    parseBody(jsonRequest('{"name":"Pikachu","quantity":"lots"}'), schema),
    (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT' && e.message.startsWith('quantity:'),
  )
})

test('parseBody rejects missing required fields', async () => {
  await assert.rejects(
    parseBody(jsonRequest('{}'), schema),
    (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
  )
})

test('parseBody applies schema defaults', async () => {
  const withDefault = z.object({
    role: z.enum(['admin', 'staff']).default('staff'),
  })
  const data = await parseBody(jsonRequest('{}'), withDefault)
  assert.deepEqual(data, { role: 'staff' })
})

test('parseIdParam accepts positive integer strings', () => {
  assert.equal(parseIdParam('1'), 1)
  assert.equal(parseIdParam('42'), 42)
})

test('parseIdParam rejects non-numeric, empty, zero, negative and fractional ids', () => {
  for (const bad of ['abc', '', '0', '-1', '1.5', '12abc', null, undefined]) {
    assert.throws(
      () => parseIdParam(bad),
      (e: unknown) => e instanceof DomainError && e.code === 'INVALID_INPUT',
      `expected ${String(bad)} to be rejected`,
    )
  }
})

test('parseIdParam uses the field name in the error message', () => {
  assert.throws(
    () => parseIdParam('nope', 'cardId'),
    (e: unknown) => e instanceof DomainError && e.message === 'Invalid cardId',
  )
})
