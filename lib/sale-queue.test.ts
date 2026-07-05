import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readQueue, enqueueSale, removeSale, setConflict, clearConflict, type QueuedSaleBody } from './sale-queue'

// Minimal in-memory Storage stand-in
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size },
  } as Storage
}

let storage: Storage
beforeEach(() => { storage = fakeStorage() })

const body = (uuid: string): QueuedSaleBody => ({
  items: [{ inventoryItemId: 1, quantity: 1 }],
  paymentMethod: 'cash',
  discountAmount: 0,
  expectedTotal: 850,
  clientUuid: uuid,
})

test('enqueue preserves order and round-trips through storage', () => {
  enqueueSale(body('a'), storage)
  enqueueSale(body('b'), storage)
  const q = readQueue(storage)
  assert.deepEqual(q.map(e => e.clientUuid), ['a', 'b'])
  assert.equal(q[0].body.expectedTotal, 850)
})

test('removeSale drops only the matching entry', () => {
  enqueueSale(body('a'), storage)
  enqueueSale(body('b'), storage)
  removeSale('a', storage)
  assert.deepEqual(readQueue(storage).map(e => e.clientUuid), ['b'])
})

test('conflicts can be set and cleared', () => {
  enqueueSale(body('a'), storage)
  setConflict('a', { code: 'INSUFFICIENT_STOCK', error: 'Insufficient stock' }, storage)
  assert.equal(readQueue(storage)[0].conflict?.code, 'INSUFFICIENT_STOCK')
  clearConflict('a', storage)
  assert.equal(readQueue(storage)[0].conflict, undefined)
})

test('corrupt storage reads as an empty queue', () => {
  storage.setItem('pokedb.saleQueue', 'not json{')
  assert.deepEqual(readQueue(storage), [])
})
