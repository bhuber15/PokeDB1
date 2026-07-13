import { test } from 'node:test'
import assert from 'node:assert'
import { createTenantDatabase } from './turso'

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch
}

test('falls back to a local file DB without TURSO_API_TOKEN', async () => {
  delete process.env.TURSO_API_TOKEN
  const r = await createTenantDatabase('brads-cards')
  assert.deepEqual(r, { dbUrl: 'file:./tenant-dbs/shop-brads-cards.db', created: true })
})

test('creates via the Turso platform API', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  process.env.TURSO_GROUP = 'fra-group'
  let posted: { url: string; body: Record<string, unknown> } | null = null
  const r = await createTenantDatabase('brads-cards', fakeFetch((url, init) => {
    posted = { url, body: JSON.parse(String(init!.body)) }
    return new Response(JSON.stringify({ database: { Hostname: 'shop-brads-cards-my-org.turso.io' } }), { status: 200 })
  }))
  assert.deepEqual(r, { dbUrl: 'libsql://shop-brads-cards-my-org.turso.io', created: true })
  assert.equal(posted!.url, 'https://api.turso.tech/v1/organizations/my-org/databases')
  assert.deepEqual(posted!.body, { name: 'shop-brads-cards', group: 'fra-group' })
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG; delete process.env.TURSO_GROUP
})

test('409 (already exists) resolves the existing hostname', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  const r = await createTenantDatabase('brads-cards', fakeFetch((url, init) => {
    if (init?.method === 'POST') return new Response('conflict', { status: 409 })
    assert.ok(url.endsWith('/databases/shop-brads-cards'))
    return new Response(JSON.stringify({ database: { Hostname: 'shop-brads-cards-my-org.turso.io' } }), { status: 200 })
  }))
  assert.deepEqual(r, { dbUrl: 'libsql://shop-brads-cards-my-org.turso.io', created: false })
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG
})

test('other API failures throw', async () => {
  process.env.TURSO_API_TOKEN = 'tok'
  process.env.TURSO_ORG = 'my-org'
  await assert.rejects(
    () => createTenantDatabase('brads-cards', fakeFetch(() => new Response('boom', { status: 500 }))),
    /Turso create failed: 500/,
  )
  delete process.env.TURSO_API_TOKEN; delete process.env.TURSO_ORG
})
