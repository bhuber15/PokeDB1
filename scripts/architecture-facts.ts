// Facts about the codebase that the architecture map displays but must never
// assert by hand. Counting them at build time is what stops the map's header
// from quietly disagreeing with the repo — a stale number is worse than none,
// because it gets believed.
//
// Shared by scripts/build-architecture-page.ts and scripts/architecture-map.test.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'test-results', 'playwright-report'])

function walk(dir: string, hit: (path: string) => void): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, hit)
    else hit(full)
  }
}

export interface Facts {
  routes: number
  domainModules: number
  tables: number
  migrations: number
  latestMigration: string
  testFiles: number
}

export function deriveFacts(root: string = process.cwd()): Facts {
  let routes = 0
  walk(join(root, 'app', 'api'), p => { if (p.endsWith('route.ts')) routes++ })

  const domainModules = readdirSync(join(root, 'lib', 'domain'))
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).length

  const schema = readFileSync(join(root, 'lib', 'db', 'schema.ts'), 'utf8')
  const tables = (schema.match(/sqliteTable\(/g) ?? []).length

  const migrationFiles = readdirSync(join(root, 'lib', 'db', 'migrations'))
    .filter(f => f.endsWith('.sql')).sort()

  let testFiles = 0
  walk(root, p => { if (/\.test\.tsx?$/.test(relative(root, p))) testFiles++ })

  return {
    routes,
    domainModules,
    tables,
    migrations: migrationFiles.length,
    latestMigration: migrationFiles[migrationFiles.length - 1]?.slice(0, 4) ?? '????',
    testFiles,
  }
}

// Fills in any stat carrying a `derive` key. Stats with a literal `value`
// (things no script can count, like "integer pence, no floats") pass through.
export function applyFacts(
  stats: { label: string; value?: string; derive?: string }[],
  facts: Facts,
  size: { nodes: number; views: number },
): { label: string; value: string }[] {
  const table: Record<string, string> = {
    routes: String(facts.routes),
    domainModules: String(facts.domainModules),
    tables: String(facts.tables),
    migrations: `${facts.migrations} · at ${facts.latestMigration}`,
    testFiles: String(facts.testFiles),
    mapped: `${size.nodes} parts · ${size.views} areas`,
  }
  return stats.map(s => {
    if (!s.derive) {
      if (s.value == null) throw new Error(`stat "${s.label}" has neither value nor derive`)
      return { label: s.label, value: s.value }
    }
    const v = table[s.derive]
    if (v == null) throw new Error(`stat "${s.label}" derives from unknown fact "${s.derive}"`)
    return { label: s.label, value: v }
  })
}
