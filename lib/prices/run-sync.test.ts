import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from '@/lib/db/test-helpers'
import { runFullPriceSync } from '@/lib/prices/run-sync'

test('nightly sync runs EN sweep, in-stock, rotation, tcgdex sweep, prune — and reports each', async () => {
  const db = await createTestDb()
  const calls: string[] = []
  const result = await runFullPriceSync(db, {
    sweepTcgplayer: async () => { calls.push('en'); return { pagesFetched: 0, pagesFailed: 0, cardsSeen: 0, newCards: 0, pricesUpdated: 0 } },
    syncInStock: async () => { calls.push('instock'); return { synced: 0, failed: 0 } },
    syncStale: async () => { calls.push('rotation'); return { synced: 0, failed: 0, remaining: 0 } },
    sweepTcgdex: async () => { calls.push('tcgdex'); return { setsChecked: 0, setsImported: 0, setsFailed: 0, cardsSeen: 0, newCards: 0 } },
    prune: async () => { calls.push('prune') },
  })
  assert.deepEqual(calls, ['en', 'tcgdex', 'instock', 'rotation', 'prune'])
  assert.ok(result.tcgdexSweep)
})

test('nightly sync runs the MTG and YGO sweeps and reports each', async () => {
  const db = await createTestDb()
  const calls: string[] = []
  const noSweep = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  const result = await runFullPriceSync(db, {
    sweepTcgplayer: async () => { calls.push('en'); return { pagesFetched: 0, pagesFailed: 0, cardsSeen: 0, newCards: 0, pricesUpdated: 0 } },
    sweepTcgdex: async () => { calls.push('tcgdex'); return { setsChecked: 0, setsImported: 0, setsFailed: 0, cardsSeen: 0, newCards: 0 } },
    sweepScryfall: async () => { calls.push('mtg'); return noSweep },
    sweepYgo: async () => { calls.push('ygo'); return noSweep },
    syncInStock: async () => { calls.push('instock'); return { synced: 0, failed: 0 } },
    syncStale: async () => { calls.push('rotation'); return { synced: 0, failed: 0, remaining: 0 } },
    prune: async () => { calls.push('prune') },
  })
  assert.ok(calls.includes('mtg') && calls.includes('ygo'))
  assert.ok(result.scryfallSweep && result.ygoSweep)
})
