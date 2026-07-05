// localStorage-backed queue for sales that failed to reach the server
// (network failure only — HTTP errors are handled normally at checkout).
// Storage is injectable so tests can run without a browser.

export interface QueuedSaleBody {
  items: { inventoryItemId: number; quantity: number }[]
  paymentMethod: string
  discountAmount: number
  expectedTotal: number
  customerId?: number
  clientUuid: string
}

export interface QueuedSale {
  clientUuid: string
  body: QueuedSaleBody
  queuedAt: string
  // Set when replay got a definitive rejection (e.g. INSUFFICIENT_STOCK,
  // PRICE_CHANGED). Conflicts are never auto-retried — a human resolves them.
  conflict?: { code: string; error: string }
}

const KEY = 'pokedb.saleQueue'

export function readQueue(storage: Storage = localStorage): QueuedSale[] {
  try {
    const raw = storage.getItem(KEY)
    return raw ? (JSON.parse(raw) as QueuedSale[]) : []
  } catch {
    return [] // corrupt entry — treat as empty rather than crash the POS
  }
}

function write(queue: QueuedSale[], storage: Storage): void {
  storage.setItem(KEY, JSON.stringify(queue))
}

export function enqueueSale(body: QueuedSaleBody, storage: Storage = localStorage): QueuedSale {
  const entry: QueuedSale = { clientUuid: body.clientUuid, body, queuedAt: new Date().toISOString() }
  write([...readQueue(storage), entry], storage)
  return entry
}

export function removeSale(clientUuid: string, storage: Storage = localStorage): void {
  write(readQueue(storage).filter(e => e.clientUuid !== clientUuid), storage)
}

export function setConflict(clientUuid: string, conflict: { code: string; error: string }, storage: Storage = localStorage): void {
  write(readQueue(storage).map(e => e.clientUuid === clientUuid ? { ...e, conflict } : e), storage)
}

export function clearConflict(clientUuid: string, storage: Storage = localStorage): void {
  write(readQueue(storage).map(e => {
    if (e.clientUuid !== clientUuid) return e
    const { conflict: _drop, ...rest } = e
    return rest
  }), storage)
}
