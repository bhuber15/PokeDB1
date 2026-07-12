import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'

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
  const offenders = files.filter(f => {
    if (ALLOWED_SINGLETON_IMPORTS.has(f)) return false
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    return /import\s*{[^}]*\bdb\b[^}]*}\s*from\s*'@\/lib\/db'/.test(src)
  })
  assert.deepEqual(offenders, [])
})
