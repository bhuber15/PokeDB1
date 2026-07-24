import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeYgoCard, type YgoCard } from '@/lib/apis/ygoprodeck'

const darkMagician: YgoCard = {
  id: 46986414, name: 'Dark Magician', type: 'Normal Monster',
  card_images: [{ image_url: 'dm.jpg', image_url_small: 'dm-small.jpg' }],
  card_prices: [{ cardmarket_price: '0.02', tcgplayer_price: '0.27' }],
  card_sets: [
    { set_name: 'Legend of Blue Eyes', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' },
    { set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '1.50' },
  ],
}

test('one row per printing, priced from set_price (USD), cardmarket null', () => {
  const rows = normalizeYgoCard(darkMagician)
  assert.equal(rows.length, 2)
  const lob = rows.find(r => r.setNumber === 'LOB-005')!
  assert.equal(lob.game, 'yugioh')
  assert.equal(lob.language, 'EN')
  assert.equal(lob.name, 'Dark Magician')
  assert.equal(lob.setName, 'Legend of Blue Eyes')
  assert.equal(lob.variant, 'Ultra Rare')
  assert.equal(lob.externalId, 'ygoprodeck:46986414:LOB-005:UR')
  assert.equal(lob.prices.tcgplayerUsd, 120)   // the rare printing is priced high
  assert.equal(lob.prices.cardmarketEur, null) // no honest per-printing EUR
  assert.equal(lob.imageUrl, 'dm-small.jpg')
  const sdy = rows.find(r => r.setNumber === 'SDY-006')!
  assert.equal(sdy.prices.tcgplayerUsd, 1.5)   // the common is priced low — different row
})

test('a 0.00 set_price becomes null (no-price workflow), not a 0 quote', () => {
  const rows = normalizeYgoCard({ ...darkMagician,
    card_sets: [{ set_name: 'X', set_code: 'X-001', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '0.00' }] })
  assert.equal(rows[0].prices.tcgplayerUsd, null)
})

test('a printing with an empty rarity code still gets a valid, round-tripping id (~1,400 real cases)', () => {
  const [row] = normalizeYgoCard({ ...darkMagician,
    card_sets: [{ set_name: 'X', set_code: 'X-001', set_rarity: 'Short Print', set_rarity_code: '', set_price: '1.00' }] })
  assert.equal(row.externalId, 'ygoprodeck:46986414:X-001:ShortPrint')
})

test('a printing with a blank set_code is filtered out (no phantom rows)', () => {
  const rows = normalizeYgoCard({ ...darkMagician,
    card_sets: [
      { set_name: 'Placeholder', set_code: '', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '1.00' },
      { set_name: 'Legend of Blue Eyes', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' },
    ] })
  assert.equal(rows.length, 1) // the blank-set_code entry produced no phantom row
  assert.equal(rows[0].setNumber, 'LOB-005')
})

test('a card with no card_sets (unreleased/anime) yields no rows', () => {
  assert.deepEqual(normalizeYgoCard({ ...darkMagician, card_sets: undefined }), [])
})
