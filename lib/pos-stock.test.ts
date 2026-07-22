import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySaleToCardResults, applySaleToProductResults } from './pos-stock'

const cardResults = () => [
  {
    card: 'Pikachu',
    inventoryOptions: [
      { itemId: 1, condition: 'NM', quantity: 98 },
      { itemId: 2, condition: 'LP', quantity: 5 },
    ],
  },
  {
    card: 'Charizard',
    inventoryOptions: [{ itemId: 3, condition: 'NM', quantity: 1 }],
  },
]

test('applySaleToCardResults: decrements the sold option, leaves the rest alone', () => {
  const next = applySaleToCardResults(cardResults(), [{ inventoryItemId: 1, quantity: 2 }])
  assert.equal(next[0].inventoryOptions[0].quantity, 96)
  assert.equal(next[0].inventoryOptions[1].quantity, 5)
  assert.equal(next[1].inventoryOptions[0].quantity, 1)
})

test('applySaleToCardResults: an option sold to zero is removed, the card row stays', () => {
  const next = applySaleToCardResults(cardResults(), [{ inventoryItemId: 3, quantity: 1 }])
  assert.equal(next.length, 2)
  assert.deepEqual(next[1].inventoryOptions, [])
  assert.equal(next[1].card, 'Charizard')
})

test('applySaleToCardResults: multiple lines in one sale all apply', () => {
  const next = applySaleToCardResults(cardResults(), [
    { inventoryItemId: 1, quantity: 90 },
    { inventoryItemId: 2, quantity: 5 },
  ])
  assert.deepEqual(next[0].inventoryOptions, [{ itemId: 1, condition: 'NM', quantity: 8 }])
})

test('applySaleToCardResults: sold lines not on screen are ignored', () => {
  const next = applySaleToCardResults(cardResults(), [{ inventoryItemId: 99, quantity: 4 }])
  assert.deepEqual(next, cardResults())
})

test('applySaleToCardResults: preserves extra fields on rows and options', () => {
  const rows = [{
    prices: { trend: 123 },
    inventoryOptions: [{ itemId: 1, quantity: 3, sellPriceOverride: 500 }],
  }]
  const next = applySaleToCardResults(rows, [{ inventoryItemId: 1, quantity: 1 }])
  assert.equal(next[0].prices.trend, 123)
  assert.equal(next[0].inventoryOptions[0].sellPriceOverride, 500)
  assert.equal(next[0].inventoryOptions[0].quantity, 2)
})

test('applySaleToProductResults: decrements, and drops rows sold to zero', () => {
  const products = [
    { itemId: 10, name: 'Booster', quantity: 4 },
    { itemId: 11, name: 'Sleeves', quantity: 2 },
  ]
  const next = applySaleToProductResults(products, [
    { inventoryItemId: 10, quantity: 1 },
    { inventoryItemId: 11, quantity: 2 },
  ])
  assert.deepEqual(next, [{ itemId: 10, name: 'Booster', quantity: 3 }])
})

test('applySaleToProductResults: untouched rows pass through unchanged', () => {
  const products = [{ itemId: 10, name: 'Booster', quantity: 4 }]
  assert.deepEqual(applySaleToProductResults(products, []), products)
})
