// Builds docs/architecture/explorer.html from map.json + template.html.
//
//   npx tsx scripts/build-architecture-page.ts
//
// map.json is the source of truth for everything authored; the header counts
// are derived from the repo at build time so they cannot drift. explorer.html
// is generated — it is rebuilt on every run and architecture-map.test.ts fails
// when the committed copy is stale.
//
// The page is published as an artifact, where a strict CSP blocks every
// external fetch, so the data travels inline in the file.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyFacts, deriveFacts } from './architecture-facts'

export interface MapNode {
  id: string
  label: string
  file?: string
  pos?: Record<string, [number, number]>
  children?: { id: string; label: string }[]
  [k: string]: unknown
}

export interface MapView {
  id: string
  label: string
  blurb: string
  intro: string
  groups: { label: string; nodes: string[] }[]
  flow: { node: string; note: string }[]
}

export interface ArchitectureMap {
  stats: { label: string; value?: string; derive?: string }[]
  views: MapView[]
  nodes: MapNode[]
  edges: { from: string; to: string; kind: string; label?: string }[]
  [k: string]: unknown
}

export const ARCH_DIR = join(process.cwd(), 'docs', 'architecture')

export function readMap(dir: string = ARCH_DIR): ArchitectureMap {
  return JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8')) as ArchitectureMap
}

export function buildPage(dir: string = ARCH_DIR): string {
  const map = readMap(dir)
  map.stats = applyFacts(map.stats, deriveFacts(), { nodes: map.nodes.length, views: map.views.length })

  const data = JSON.stringify(map)
  if (data.includes('</script')) {
    throw new Error('map.json contains "</script" — it would break out of the inline data block')
  }

  const template = readFileSync(join(dir, 'template.html'), 'utf8')
  if (!template.includes('__MAP_JSON__')) {
    throw new Error('template.html has no __MAP_JSON__ placeholder')
  }
  return template.replace('__MAP_JSON__', () => data)
}

if (process.argv[1]?.endsWith('build-architecture-page.ts')) {
  const out = buildPage()
  writeFileSync(join(ARCH_DIR, 'explorer.html'), out)
  const map = readMap()
  console.log(`built docs/architecture/explorer.html — ${map.nodes.length} nodes, ${map.edges.length} edges, ${(out.length / 1024).toFixed(0)}KB`)
}
