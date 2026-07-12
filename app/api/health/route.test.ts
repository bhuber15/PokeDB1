import { test } from 'node:test'
import assert from 'node:assert'
import { GET } from './route'

test('health returns ok with db reachable', async () => {
  const res = await GET()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, db: true })
})
