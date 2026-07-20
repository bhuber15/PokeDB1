import { test } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import { join } from 'node:path'

// The lockfile's @types/node is pinned to the Node 20 API surface, which
// predates fs.globSync (stabilized in a later Node release the runtime here
// already has). Pull it out via a narrowly-typed cast rather than `any` so
// this doesn't wait on an @types/node bump.
const globSync = (fs as unknown as { globSync: (pattern: string, opts: { cwd: string }) => string[] })
  .globSync
const readFileSync = fs.readFileSync

// Routes must resolve the tenant Db per request; importing the singleton
// binds them to single-tenant mode and breaks isolation in multi mode.
//
// app/api/health/route.ts is an approved exception: it's an unauthenticated
// platform liveness check that runs before any tenant is resolved (there are
// no trusted tenant headers yet to resolve one from). In single mode it pings
// the singleton directly; in multi mode it pings the platform registry via
// getPlatformDb() instead. This is by design, not an unswept route.
const ALLOWED_SINGLETON_IMPORTS = new Set(['app/api/health/route.ts'])

test('no API route imports the db singleton', () => {
  const files = globSync('app/api/**/route.ts', { cwd: process.cwd() })
  assert.ok(files.length >= 30, `expected to find route files, got ${files.length}`)
  const offenders = files.filter((f: string) => {
    if (ALLOWED_SINGLETON_IMPORTS.has(f)) return false
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    return /import\s*{[^}]*\bdb\b[^}]*}\s*from\s*'@\/lib\/db'/.test(src)
  })
  assert.deepEqual(offenders, [])
})

// Server components (layouts/pages) are just as exposed as API routes: they
// run on the request path and must resolve a tenant Db too. This slipped
// through the original route sweep (see C1 in the final-review pass) — app
// layout and the login page called getSettings()/countInStockWants() with no
// args, silently binding to the single-tenant singleton default.
test('no server component (layout/page) imports the db singleton or calls getSettings()/countInStockWants() bare', () => {
  const files = [
    ...globSync('app/**/layout.tsx', { cwd: process.cwd() }),
    ...globSync('app/**/page.tsx', { cwd: process.cwd() }),
  ]
  assert.ok(files.length >= 10, `expected to find layout/page files, got ${files.length}`)
  const offenders = files.filter(f => {
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    const importsSingleton = /import\s*{[^}]*\bdb\b[^}]*}\s*from\s*'@\/lib\/db'/.test(src)
    const bareCall = /\b(getSettings|countInStockWants)\(\)/.test(src)
    return importsSingleton || bareCall
  })
  assert.deepEqual(offenders, [])
})
