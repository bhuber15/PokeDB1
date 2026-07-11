import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupInStockWants, cardLabel, type WantRow } from './wants-grouping'

function want(partial: Partial<WantRow> & Pick<WantRow, 'id' | 'customerId'>): WantRow {
  return {
    id: partial.id,
    customerId: partial.customerId,
    cardId: partial.cardId ?? null,
    freeText: partial.freeText ?? null,
    notify: partial.notify ?? true,
    createdAt: partial.createdAt ?? '2026-07-11T00:00:00Z',
    customerName: partial.customerName ?? null,
    customerPhone: partial.customerPhone ?? null,
    customerEmail: partial.customerEmail ?? null,
    cardName: partial.cardName ?? null,
    cardSetName: partial.cardSetName ?? null,
    cardSetNumber: partial.cardSetNumber ?? null,
    inStock: partial.inStock ?? false,
  }
}

test('cardLabel formats name, set and number, falling back to free text', () => {
  assert.equal(
    cardLabel({ cardName: 'Pikachu', cardSetName: 'Base Set', cardSetNumber: '58/102', freeText: null }),
    'Pikachu — Base Set #58/102',
  )
  assert.equal(
    cardLabel({ cardName: null, cardSetName: null, cardSetNumber: null, freeText: 'Charizard promo' }),
    'Charizard promo',
  )
  assert.equal(
    cardLabel({ cardName: 'Pikachu', cardSetName: null, cardSetNumber: null, freeText: null }),
    'Pikachu',
  )
  assert.equal(
    cardLabel({ cardName: null, cardSetName: null, cardSetNumber: null, freeText: null }),
    '(unknown)',
  )
})

test('groups multiple in-stock customers under one card', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Pikachu', customerName: 'Zoe', inStock: true }),
    want({ id: 2, customerId: 11, cardId: 3, cardName: 'Pikachu', customerName: 'Amy', inStock: true, notify: false }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].cardId, 3)
  assert.equal(groups[0].cardName, 'Pikachu')
  assert.deepEqual(groups[0].customers.map(c => c.name), ['Amy', 'Zoe']) // sorted by name
  assert.equal(groups[0].customers.find(c => c.wantId === 2)!.notify, false)
})

test('excludes out-of-stock and free-text wants', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Pikachu', inStock: false }),
    want({ id: 2, customerId: 11, cardId: null, freeText: 'Some card', inStock: true }),
  ])
  assert.equal(groups.length, 0)
})

test('orders groups by label', () => {
  const groups = groupInStockWants([
    want({ id: 1, customerId: 10, cardId: 3, cardName: 'Zapdos', inStock: true }),
    want({ id: 2, customerId: 11, cardId: 4, cardName: 'Abra', inStock: true }),
  ])
  assert.deepEqual(groups.map(g => g.cardName), ['Abra', 'Zapdos'])
})
