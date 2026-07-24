import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb, seedBase } from '../db/test-helpers'
import * as schema from '../db/schema'
import { getSets, getCardsInSet, getNames, getPrintingsByName } from './catalogue'
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

test('getNames returns distinct names, prefix-filtered and capped, alphabetised', async () => {
  await dbc.insert(schema.cards).values([
    { name: 'Pikachu VMAX', setName: 'Base Set', setNumber: '2' },
    { name: 'Raichu', setName: 'Base Set', setNumber: '3' },
  ])
  const all = await getNames(undefined, dbc)
  assert.deepEqual([...all].sort(), ['Pikachu', 'Pikachu VMAX', 'Raichu'])

  const filtered = await getNames('Pika', dbc)
  assert.deepEqual(filtered, ['Pikachu', 'Pikachu VMAX'])
})

test('getPrintingsByName returns every printing of an exact name, ordered by era then set number', async () => {
  // seeded card: id 1, 'Pikachu', 'Base Set', setNumber '58/102', series null
  await dbc.insert(schema.cards).values({
    name: 'Pikachu', setName: 'Sword & Shield Base', setNumber: '4', series: 'Sword & Shield',
  })
  await dbc.insert(schema.cards).values({ name: 'Pikachu VMAX', setName: 'Base Set', setNumber: '1' }) // different name, excluded

  const rows = await getPrintingsByName('Pikachu', dbc)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.card.setName), ['Sword & Shield Base', 'Base Set']) // ranked era before null-series seed row
})

test('catalogue queries scope to the requested game', async () => {
  const dbc = await createTestDb()
  await dbc.insert(schema.cards).values([
    { name: 'Alpha Bolt', game: 'pokemon', setName: 'Base Set', setNumber: '1', externalId: 'p1' },
    { name: 'Alpha Bolt', game: 'mtg', language: 'EN', setName: 'Alpha', setNumber: '1', externalId: 'scryfall:b' },
  ])
  const sets = await getSets(dbc, 'mtg')
  assert.ok(sets.some(s => s.setName === 'Alpha'))
  assert.ok(!sets.some(s => s.setName === 'Base Set'))
  assert.deepEqual(await getNames('Alpha', dbc, 'pokemon'), ['Alpha Bolt']) // one game's rows only
  assert.equal((await getCardsInSet('Alpha', dbc, 'pokemon')).length, 0)
  assert.equal((await getPrintingsByName('Alpha Bolt', dbc, 'mtg')).length, 1)
})
