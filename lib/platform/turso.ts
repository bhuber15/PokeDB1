import { mkdirSync } from 'node:fs'

// Turso Platform API: create one database per tenant (spec §3.2/3.6) in the
// EU group. Dev/test fallback: without TURSO_API_TOKEN the "database" is a
// local file, matching scripts/create-tenant.ts, so signup → provision →
// setup runs end-to-end on a laptop with zero cloud credentials.

export interface CreatedDb {
  dbUrl: string
  created: boolean
}

export async function createTenantDatabase(slug: string, fetchImpl: typeof fetch = fetch): Promise<CreatedDb> {
  const token = process.env.TURSO_API_TOKEN
  const name = `shop-${slug}`
  if (!token) {
    mkdirSync('./tenant-dbs', { recursive: true })
    return { dbUrl: `file:./tenant-dbs/${name}.db`, created: true }
  }
  const org = process.env.TURSO_ORG
  if (!org) throw new Error('TURSO_ORG is not set')
  const group = process.env.TURSO_GROUP ?? 'default'
  const base = `https://api.turso.tech/v1/organizations/${org}/databases`
  const auth = { authorization: `Bearer ${token}` }

  const res = await fetchImpl(base, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name, group }),
  })
  if (res.status === 409) {
    // Already exists — a webhook retry after a partial provision. Resolve the
    // hostname and carry on; provisioning is idempotent from here.
    const lookup = await fetchImpl(`${base}/${name}`, { headers: auth })
    if (!lookup.ok) throw new Error(`Turso lookup failed: ${lookup.status}`)
    const { database } = (await lookup.json()) as { database: { Hostname: string } }
    return { dbUrl: `libsql://${database.Hostname}`, created: false }
  }
  if (!res.ok) throw new Error(`Turso create failed: ${res.status} ${await res.text()}`)
  const { database } = (await res.json()) as { database: { Hostname: string } }
  return { dbUrl: `libsql://${database.Hostname}`, created: true }
}
