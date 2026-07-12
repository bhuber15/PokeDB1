import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'

// Lazy: importing this module must never dial the registry (single-tenant
// deployments have no PLATFORM_DATABASE_URL at all).
let _pdb: ReturnType<typeof make> | null = null

function make(url: string, authToken?: string) {
  return drizzle(createClient({ url, authToken }), { schema })
}

export function getPlatformDb(): PlatformDb {
  if (!_pdb) {
    const url = process.env.PLATFORM_DATABASE_URL
    if (!url) throw new Error('PLATFORM_DATABASE_URL is not set (required when TENANCY_MODE=multi)')
    _pdb = make(url, process.env.PLATFORM_AUTH_TOKEN)
  }
  return _pdb
}

export type PlatformDb = ReturnType<typeof make>
