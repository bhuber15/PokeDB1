import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from './db/test-helpers'
import * as schema from './db/schema'
import type { Db } from './db'
import { isTcgplayerExport, importTcgplayerExport } from './import-tcgplayer'

let dbc: Db

// The TCGplayer app export with every column toggled on (recorded shape —
// see the header note in import-tcgplayer.ts).
const FULL_HEADER = ['Quantity', 'Name', 'Simple Name', 'Set', 'Card Number', 'Set Code', 'Printing', 'Condition', 'Language', 'Rarity', 'Product ID', 'SKU']

function row(over: Partial<Record<string, string>>): string[] {
  return FULL_HEADER.map(h => over[h] ?? '')
}

async function cardOf(inventoryItemId: number) {
  const [item] = await dbc.select().from(schema.inventoryItems)
    .where(eq(schema.inventoryItems.id, inventoryItemId))
  return item
}

beforeEach(async () => {
  dbc = await createTestDb()
  await dbc.insert(schema.cards).values([
    // Pokémon EN: one row per card, pokemontcg.io bare numbers.
    { id: 1, name: 'Charizard ex', game: 'pokemon', setName: 'Obsidian Flames', setNumber: '125', language: 'EN', externalId: 'sv3-125' },
    { id: 2, name: 'Pikachu', game: 'pokemon', setName: 'Base', setNumber: '58', language: 'EN', externalId: 'base1-58' },
    { id: 3, name: 'Pikachu', game: 'pokemon', setName: 'Base Set 2', setNumber: '58', language: 'EN', externalId: 'base4-85' },
    { id: 4, name: 'Snorlax', game: 'pokemon', setName: 'Surging Sparks', setNumber: '85', language: 'EN', externalId: 'sv8-85' },
    // MTG: finish twins split across rows via variant.
    { id: 5, name: 'Lightning Bolt', game: 'mtg', setName: 'Double Masters 2022', setNumber: '117', variant: '', language: 'EN', externalId: 'scryfall:aaa' },
    { id: 6, name: 'Lightning Bolt', game: 'mtg', setName: 'Double Masters 2022', setNumber: '117', variant: 'Foil', language: 'EN', externalId: 'scryfall:aaa:foil' },
    // YGO: one row per printing, variant = rarity, region segment in the code.
    { id: 7, name: 'Blue-Eyes White Dragon', game: 'yugioh', setName: 'Legend of Blue Eyes White Dragon', setNumber: 'LOB-EN001', variant: 'Ultra Rare', language: 'EN', externalId: 'ygoprodeck:89631139:LOB-EN001:UR' },
    { id: 8, name: 'Blue-Eyes White Dragon', game: 'yugioh', setName: 'Legend of Blue Eyes White Dragon', setNumber: 'LOB-EN001', variant: 'Secret Rare', language: 'EN', externalId: 'ygoprodeck:89631139:LOB-EN001:SR' },
    // Lorcana: finish twins, and a " - " in the real card name.
    { id: 9, name: 'Elsa - Snow Queen', game: 'lorcana', setName: 'The First Chapter', setNumber: '41', variant: '', language: 'EN', externalId: 'lorcast:crd_1' },
    { id: 10, name: 'Elsa - Snow Queen', game: 'lorcana', setName: 'The First Chapter', setNumber: '41', variant: 'Foil', language: 'EN', externalId: 'lorcast:crd_1:foil' },
    // A JA printing sharing name/number shape with nothing above.
    { id: 11, name: 'Charizard ex', game: 'pokemon', setName: 'ポケモンカード151', setNumber: '006', language: 'JA', externalId: 'tcgdex:ja:sv2a-006' },
  ])
})

test('detects the app export and never our own template', () => {
  assert.equal(isTcgplayerExport(FULL_HEADER.map(h => h.toLowerCase())), true)
  assert.equal(isTcgplayerExport(['﻿quantity', 'simple name', 'condition']), true)
  assert.equal(isTcgplayerExport('external_id,name,set_name,set_number,game,condition,quantity,cost_price,sell_price_override,location,defect_notes'.split(',')), false)
  // Toggled-down export: no Simple Name / Product ID, but Printing + Card Number.
  assert.equal(isTcgplayerExport(['quantity', 'name', 'set', 'card number', 'printing', 'condition']), true)
})

test('pokémon row: slashed number, prefixed set name, condition map', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '2', 'Simple Name': 'Charizard ex', Name: 'Charizard ex - 125/197', Set: 'SV03: Obsidian Flames', 'Card Number': '125/197', Printing: 'Holofoil', Condition: 'Near Mint', Language: 'English' }),
  ], dbc)
  assert.deepEqual(res.errors, [])
  assert.equal(res.created, 1)
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 1)
  assert.equal(item.condition, 'NM')
  assert.equal(item.quantity, 2)
  assert.equal(item.costPrice, 0)
  assert.ok(item.qrCode)
})

test('leading zeros in the printed number are stripped', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Snorlax', Set: 'SV08: Surging Sparks', 'Card Number': '085/191', Condition: 'Lightly Played' }),
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 4)
  assert.equal(item.condition, 'LP')
})

test('reprint sets sharing a number arbitrate on the set column', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Pikachu', Set: 'Base Set', 'Card Number': '58/102', Condition: 'Moderately Played' }),
    row({ Quantity: '1', 'Simple Name': 'Pikachu', Set: 'Base Set 2', 'Card Number': '58/130', Condition: 'Heavily Played' }),
  ], dbc)
  assert.deepEqual(res.errors, [])
  const first = await cardOf(res.createdIds[0])
  const second = await cardOf(res.createdIds[1])
  assert.equal(first.cardId, 2) // "Base Set" must not drift onto "Base Set 2"
  assert.equal(first.condition, 'MP')
  assert.equal(second.cardId, 3)
  assert.equal(second.condition, 'HP')
})

test('same number in two sets with no set column is an error, not a guess', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'card number', 'condition'],
    ['1', 'Pikachu', '58', 'Near Mint'],
  ], dbc)
  assert.equal(res.created, 0)
  assert.match(res.errors[0].message, /several sets/i)
})

test('mtg printing picks the finish twin; decorated Name still matches', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'name', 'set', 'card number', 'printing', 'condition'],
    ['1', 'Lightning Bolt (Borderless)', 'Double Masters 2022', '117', 'Foil', 'Near Mint'],
    ['3', 'Lightning Bolt', 'Double Masters 2022', '117', 'Normal', 'Moderately Played'],
  ], dbc)
  assert.deepEqual(res.errors, [])
  const foil = await cardOf(res.createdIds[0])
  const plain = await cardOf(res.createdIds[1])
  assert.equal(foil.cardId, 6)
  assert.equal(plain.cardId, 5)
  assert.equal(plain.quantity, 3)
})

test('a foil-folded condition stands in for a missing Printing column', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'name', 'set', 'card number', 'condition'],
    ['1', 'Lightning Bolt', 'Double Masters 2022', '117', 'Near Mint Foil'],
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 6)
  assert.equal(item.condition, 'NM')
})

test('ygo: region-less set code resolves and rarity arbitrates printings', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Blue-Eyes White Dragon', Set: 'Legend of Blue Eyes White Dragon', 'Card Number': 'LOB-001', Condition: 'Lightly Played', Rarity: 'Secret Rare' }),
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 8)
})

test('ygo: a code printed exactly beats its regional respelling', async () => {
  // "LOB-001" and "LOB-EN001" can both exist as distinct printings — the
  // respelling must only be tried when the printed code matches nothing.
  await dbc.insert(schema.cards).values({
    id: 12, name: 'Blue-Eyes White Dragon', game: 'yugioh', setName: 'Legend of Blue Eyes White Dragon',
    setNumber: 'LOB-001', variant: 'Ultra Rare', language: 'EN', externalId: 'ygoprodeck:89631139:LOB-001:UR',
  })
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'card number', 'condition', 'rarity'],
    ['1', 'Blue-Eyes White Dragon', 'LOB-001', 'Near Mint', 'Ultra Rare'],
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 12)
})

test('ygo printings without a rarity column are an error naming the options', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'card number', 'condition'],
    ['1', 'Blue-Eyes White Dragon', 'LOB-001', 'Near Mint'],
  ], dbc)
  assert.equal(res.created, 0)
  assert.match(res.errors[0].message, /Rarity column/)
  assert.match(res.errors[0].message, /Ultra Rare/)
})

test('lorcana: dashed name survives and Foil printing picks the twin', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Elsa - Snow Queen', Set: 'The First Chapter', 'Card Number': '41/204', Printing: 'Foil', Condition: 'Mint' }),
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 10)
  assert.equal(item.condition, 'M')
})

test('language column scopes the match to that printing', async () => {
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Charizard ex', Set: 'Pokemon Card 151', 'Card Number': '006', Condition: 'Near Mint', Language: 'Japanese' }),
    row({ Quantity: '1', 'Simple Name': 'Charizard ex', 'Card Number': '125', Condition: 'Near Mint', Language: 'German' }),
  ], dbc)
  assert.equal(res.created, 1)
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.cardId, 11)
  assert.match(res.errors[0].message, /unsupported language "German"/)
})

test('unmatched rows error and never create catalogue cards', async () => {
  const before = (await dbc.select().from(schema.cards)).length
  const res = await importTcgplayerExport([
    FULL_HEADER,
    row({ Quantity: '1', 'Simple Name': 'Umbreon VMAX', Set: 'Evolving Skies', 'Card Number': '215/203', Condition: 'Near Mint' }),
    row({ Quantity: '1', 'Simple Name': 'Charizard ex', 'Card Number': '125', Condition: 'Unopened' }),
  ], dbc)
  assert.equal(res.created, 0)
  assert.equal(res.createdIds.length, 0)
  assert.match(res.errors.find(e => e.row === 2)!.message, /no catalogue match for "Umbreon VMAX"/)
  assert.match(res.errors.find(e => e.row === 3)!.message, /bad condition "Unopened"/)
  const after = (await dbc.select().from(schema.cards)).length
  assert.equal(after, before)
})

test('a right number under the wrong name reads as not-found, with hints', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'set', 'card number', 'condition'],
    ['1', 'Wartortle', 'SV08: Surging Sparks', '085/191', 'Near Mint'],
  ], dbc)
  assert.equal(res.created, 0)
  assert.match(res.errors[0].message, /"Wartortle" #085\/191 \(SV08: Surging Sparks\) not found in the catalogue/)
  assert.match(res.errors[0].message, /closest at that number: Snorlax/)
})

test('repeated scans of the same card and condition merge into one line', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'set', 'card number', 'condition'],
    ['1', 'Charizard ex', 'Obsidian Flames', '125/197', 'Near Mint'],
    ['2', 'Charizard ex', 'Obsidian Flames', '125/197', 'Near Mint'],
    ['1', 'Charizard ex', 'Obsidian Flames', '125/197', 'Damaged'],
  ], dbc)
  assert.deepEqual(res.errors, [])
  assert.equal(res.created, 2)
  const nm = await cardOf(res.createdIds[0])
  const dmg = await cardOf(res.createdIds[1])
  assert.equal(nm.quantity, 3)
  assert.equal(nm.condition, 'NM')
  assert.equal(dmg.quantity, 1)
  assert.equal(dmg.condition, 'DMG')
})

test('a structurally unusable export fails loudly on row 1', async () => {
  const res = await importTcgplayerExport([
    ['quantity', 'simple name', 'card number'],
    ['1', 'Charizard ex', '125'],
  ], dbc)
  assert.equal(res.created, 0)
  assert.match(res.errors[0].message, /Condition column/)
  assert.equal(res.errors[0].row, 1)
})

test('missing quantity column defaults each row to one copy', async () => {
  const res = await importTcgplayerExport([
    ['simple name', 'set', 'card number', 'condition'],
    ['Charizard ex', 'Obsidian Flames', '125/197', 'Near Mint'],
  ], dbc)
  assert.deepEqual(res.errors, [])
  const item = await cardOf(res.createdIds[0])
  assert.equal(item.quantity, 1)
})
