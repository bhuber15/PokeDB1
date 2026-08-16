// Keeps docs/architecture honest.
//
// A stale architecture map is worse than no map, because it gets believed. The
// map cannot be verified by a machine — the prose is the point — but its
// scaffolding can: every file it names must exist, every id it references must
// resolve, every part must be reachable from an index, and the published page
// must match the data it was built from.
//
// When one of these fails, the fix is to run the /architecture-map skill, not
// to edit the numbers.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ARCH_DIR, buildPage, readMap } from './build-architecture-page'

const map = readMap()
const nodeIds = new Set(map.nodes.map(n => n.id))
const viewIds = map.views.map(v => v.id)

test('every file the map names still exists', () => {
  const missing: string[] = []
  for (const node of map.nodes) {
    if (!node.file) continue
    // A node may name several paths, separated by " · ".
    for (const ref of node.file.split('·').map(s => s.trim()).filter(Boolean)) {
      if (!existsSync(join(process.cwd(), ref))) missing.push(`${node.id} → ${ref}`)
    }
  }
  assert.deepEqual(missing, [], 'map.json points at paths that no longer exist')
})

test('every node is placed in at least one area, and only in areas that exist', () => {
  const unplaced = map.nodes.filter(n => !n.pos || Object.keys(n.pos).length === 0).map(n => n.id)
  assert.deepEqual(unplaced, [], 'a node has no position, so it would never be drawn')

  const strays = map.nodes.flatMap(n =>
    Object.keys(n.pos ?? {}).filter(v => !viewIds.includes(v)).map(v => `${n.id} → ${v}`))
  assert.deepEqual(strays, [], 'a node is positioned in an area that does not exist')
})

test('every edge connects two nodes that exist', () => {
  const dangling = map.edges
    .filter(e => !nodeIds.has(e.from) || !nodeIds.has(e.to))
    .map(e => `${e.from} → ${e.to}`)
  assert.deepEqual(dangling, [])
})

test('every edge is drawn somewhere — both ends share at least one area', () => {
  const orphaned = map.edges.filter(e => {
    const a = map.nodes.find(n => n.id === e.from)?.pos ?? {}
    const b = map.nodes.find(n => n.id === e.to)?.pos ?? {}
    return !Object.keys(a).some(v => v in b)
  }).map(e => `${e.from} → ${e.to}`)
  assert.deepEqual(orphaned, [], 'an edge exists whose ends never appear in the same area')
})

test('each area indexes exactly the nodes it places', () => {
  for (const view of map.views) {
    const indexed = view.groups.flatMap(g => g.nodes)
    const placed = map.nodes.filter(n => n.pos?.[view.id]).map(n => n.id)

    assert.deepEqual(indexed.filter(id => !nodeIds.has(id)), [], `${view.id}: group lists an unknown node`)
    assert.deepEqual(
      indexed.filter(id => !placed.includes(id)), [],
      `${view.id}: a node is in the index but has no position in this area`)
    assert.deepEqual(
      placed.filter(id => !indexed.includes(id)), [],
      `${view.id}: a node is drawn but missing from the index, so it can only be found by hunting`)
    assert.deepEqual(
      indexed.filter((id, i) => indexed.indexOf(id) !== i), [],
      `${view.id}: a node is listed in two groups`)
  }
})

test('every walkthrough step points at a node drawn in that area', () => {
  for (const view of map.views) {
    const bad = view.flow.filter(s => !map.nodes.find(n => n.id === s.node)?.pos?.[view.id]).map(s => s.node)
    assert.deepEqual(bad, [], `${view.id}: a walkthrough step names a node that area does not draw`)
  }
})

test('no id is used twice, including inside drill-downs', () => {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const node of map.nodes) {
    for (const id of [node.id, ...(node.children ?? []).map(c => c.id)]) {
      if (seen.has(id)) dupes.push(id)
      seen.add(id)
    }
  }
  assert.deepEqual(dupes, [])
})

test('the published page matches the map it was built from', () => {
  const onDisk = readFileSync(join(ARCH_DIR, 'explorer.html'), 'utf8')
  assert.equal(
    onDisk,
    buildPage(),
    'docs/architecture/explorer.html is stale — run: npx tsx scripts/build-architecture-page.ts',
  )
})
