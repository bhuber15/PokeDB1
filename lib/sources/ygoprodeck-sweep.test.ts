import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import type { YgoCard } from '@/lib/apis/ygoprodeck'

const dump: YgoCard[] = [{
  id: 46986414, name: 'Dark Magician', type: 'Normal Monster',
  card_images: [{ image_url: 'dm.jpg', image_url_small: 'dm-s.jpg' }], card_prices: [{}],
  card_sets: [
    { set_name: 'LOB', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' },
    { set_name: 'SDY', set_code: 'SDY-006', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '1.50' },
  ],
}]
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'yugioh' as const] }

test('imports every printing as its own row when yugioh is enabled', async () => {
  const db = await createTestDb()
  const r = await sweepYgoprodeck(settings, db, { fetchDump: async () => dump })
  assert.equal(r.newCards, 2)
  const rows = await db.select().from(cards).where(eq(cards.game, 'yugioh'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(c => c.setNumber).sort(), ['LOB-005', 'SDY-006'])
})

test('does nothing when yugioh is not enabled', async () => {
  const db = await createTestDb()
  const r = await sweepYgoprodeck({ ...settings, enabledGames: ['pokemon'] }, db, { fetchDump: async () => dump })
  assert.equal(r.cardsSeen, 0)
})
