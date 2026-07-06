import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getSets, getCardsInSet } from './catalogue'
import type { Db } from '../db'

let dbc: Db

beforeEach(async () => {
  dbc = await createTestDb()
  await seedBase(dbc) // card id 1 'Pikachu', 'Base Set', setNumber '58/102', series null
})

test('getSets groups by set name + series, ordered by era then name, with counts', async () => {
  await dbc.update(schema.cards).set({ series: 'Base' }).where(eq(schema.cards.id, 1))
  await dbc.insert(schema.cards).values([
    { name: 'Charizard', setName: 'Base Set', setNumber: '4', series: 'Base' },
    { name: 'Sprigatito', setName: 'Scarlet & Violet', setNumber: '1', series: 'Scarlet & Violet' },
    { name: 'Old Card', setName: 'Mystery Set', setNumber: '1', series: null },
  ])

  const sets = await getSets(dbc)
  assert.deepEqual(sets.map(s => s.setName), ['Base Set', 'Scarlet & Violet', 'Mystery Set'])
  assert.equal(sets.find(s => s.setName === 'Base Set')!.count, 2)
  assert.equal(sets.find(s => s.setName === 'Mystery Set')!.series, null)
})

test('getCardsInSet returns all cards in a set ordered by set number, joined to prices', async () => {
  await dbc.update(schema.cards).set({ setNumber: '10' }).where(eq(schema.cards.id, 1))
  const [raichu] = await dbc.insert(schema.cards)
    .values({ name: 'Raichu', setName: 'Base Set', setNumber: '2' })
    .returning({ id: schema.cards.id })
  await dbc.insert(schema.priceCache).values({ cardId: raichu.id, tcgplayerMarket: 500 })

  const rows = await getCardsInSet('Base Set', dbc)
  assert.deepEqual(rows.map(r => r.card.name), ['Raichu', 'Pikachu']) // '2' before '10' numerically
  assert.equal(rows.find(r => r.card.name === 'Raichu')!.prices?.tcgplayerMarket, 500)
  assert.equal(rows.find(r => r.card.name === 'Pikachu')!.prices, null)
})

test('getCardsInSet returns nothing for an unknown set name', async () => {
  const rows = await getCardsInSet('Nonexistent Set', dbc)
  assert.deepEqual(rows, [])
})
