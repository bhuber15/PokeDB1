'use client'
import { useState, useEffect } from 'react'
import { SearchBar } from '@/components/pos/SearchBar'
import { CardResult, InventoryOption } from '@/components/pos/CardResult'
import { ProductResult } from '@/components/pos/ProductResult'
import { Cart, CartItem } from '@/components/pos/Cart'
import { CheckoutDialog } from '@/components/pos/CheckoutDialog'
import { ReceiptDialog, type ReceiptData } from '@/components/pos/ReceiptDialog'
import type { CheckoutConfirmOptions } from '@/components/pos/CheckoutDialog'
import { SaleQueue } from '@/components/pos/SaleQueue'
import { useSettings } from '@/components/shared/SettingsProvider'
import { toast } from 'sonner'
import { formatGBP, computeSaleTotals } from '@/lib/pricing'
import {
  readQueue, enqueueSale, removeSale, setConflict, clearConflict, type QueuedSale,
} from '@/lib/sale-queue'
import { applySaleToCardResults, applySaleToProductResults, type SoldLine } from '@/lib/pos-stock'
import type { Card, PriceCache, Product } from '@/lib/db/schema'

interface SearchState {
  card: Card
  prices: PriceCache | null
  inventoryOptions: InventoryOption[]
}

interface InvRow {
  item: { id: number; cardId: number | null; productId: number | null; condition: string; quantity: number; sellPriceOverride: number | null }
  card: Card | null
  product: Product | null
  prices: PriceCache | null
}

// Group raw inventory rows into one SearchState per distinct card (in-stock only).
function groupByCard(rows: InvRow[]): SearchState[] {
  const byCard = new Map<number, SearchState>()
  for (const r of rows) {
    if (r.item.quantity <= 0) continue
    const cid = r.card?.id ?? r.item.cardId
    if (cid == null) continue
    let g = byCard.get(cid)
    if (!g) {
      g = { card: r.card ?? ({ id: cid } as Card), prices: r.prices, inventoryOptions: [] }
      byCard.set(cid, g)
    }
    g.inventoryOptions.push({
      itemId: r.item.id, condition: r.item.condition,
      quantity: r.item.quantity, sellPriceOverride: r.item.sellPriceOverride,
    })
  }
  return [...byCard.values()]
}

interface ProductHit { product: Product; itemId: number; quantity: number; price: number }

function extractProducts(rows: InvRow[]): ProductHit[] {
  return rows
    .filter(r => r.product != null && r.item.quantity > 0)
    .map(r => ({ product: r.product!, itemId: r.item.id, quantity: r.item.quantity, price: r.item.sellPriceOverride ?? 0 }))
}

export default function POSPage() {
  const { shopName, vatScheme } = useSettings()
  const [results, setResults] = useState<SearchState[]>([])
  const [productResults, setProductResults] = useState<ProductHit[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [queue, setQueue] = useState<QueuedSale[]>([])
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)

  // Arriving via a link like /pos?q=Pikachu (e.g. the want list's Sell button)
  // runs the search immediately. Timer defers past the effect's sync phase.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (!q) return
    const t = setTimeout(() => handleSearch(q), 0)
    return () => clearTimeout(t)
  }, [])

  // Replay queued offline sales: on load, when the browser comes back
  // online, and every 30s while anything is still queued. Conflicts are
  // left for a human (Retry/Discard in the SaleQueue panel).
  useEffect(() => {
    let cancelled = false
    async function replay() {
      for (const entry of readQueue().filter(e => !e.conflict)) {
        if (cancelled) return
        let res: Response
        try {
          res = await fetch('/api/sales', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.body),
          })
        } catch {
          break // still offline — try again on the next tick
        }
        if (res.ok) {
          const { total } = await res.json()
          removeSale(entry.clientUuid)
          toast.success(`Queued sale sent — ${formatGBP(total)}`)
        } else if (res.status === 401) {
          break // logged out — leave queued, replays after sign-in
        } else {
          const data = await res.json().catch(() => null)
          setConflict(entry.clientUuid, {
            code: data?.code ?? `HTTP_${res.status}`,
            error: data?.error ?? 'Sale was rejected',
          })
        }
      }
      if (!cancelled) setQueue(readQueue())
    }
    const t = setTimeout(replay, 0)
    const interval = setInterval(() => { if (readQueue().some(e => !e.conflict)) replay() }, 30_000)
    window.addEventListener('online', replay)
    return () => {
      cancelled = true
      clearTimeout(t)
      clearInterval(interval)
      window.removeEventListener('online', replay)
    }
  }, [])

  async function handleSearch(query: string) {
    setLoading(true)
    const res = await fetch(`/api/inventory?q=${encodeURIComponent(query)}`)
    const rows = (await res.json()) as InvRow[]
    const grouped = groupByCard(rows)
    const productHits = extractProducts(rows)
    if (grouped.length === 0 && productHits.length === 0) {
      toast.error(`No in-stock items found for "${query}"`)
      setResults([])
      setProductResults([])
      setLoading(false)
      return
    }
    setResults(grouped)
    setProductResults(productHits)
    setLoading(false)
  }

  async function handleQRDetected(qrCode: string) {
    setLoading(true)
    const res = await fetch(`/api/inventory?qrCode=${encodeURIComponent(qrCode)}`)
    const rows = (await res.json()) as InvRow[]
    const grouped = groupByCard(rows)
    const productHits = extractProducts(rows)
    if (grouped.length === 0 && productHits.length === 0) {
      toast.error('QR code not found in inventory')
      setResults([])
      setProductResults([])
      setLoading(false)
      return
    }
    setResults(grouped)
    setProductResults(productHits)
    setLoading(false)
  }

  // Live single-card price refresh (F10): re-fetch Cardmarket for this card
  // via the on-demand endpoint from the buylist flow, then swap the updated
  // price_cache row into the search results in place.
  async function handleRefreshPrice(cardId: number) {
    try {
      const res = await fetch(`/api/prices/cardmarket?cardId=${cardId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(body?.error ?? 'Price refresh failed')
        return
      }
      const { prices } = await res.json()
      if (!prices) {
        toast.info('No Cardmarket price available for this card')
        return
      }
      setResults(prev => prev.map(r => (r.card.id === cardId ? { ...r, prices } : r)))
      toast.success('Price refreshed')
    } catch {
      toast.error('Network error — price not refreshed')
    }
  }

  function handleAddToCart(itemId: number, name: string, condition: string, price: number, qty: number) {
    setCart(prev => {
      const existing = prev.find(i => i.inventoryItemId === itemId)
      if (existing) {
        return prev.map(i => i.inventoryItemId === itemId ? { ...i, quantity: i.quantity + qty } : i)
      }
      return [...prev, { inventoryItemId: itemId, name, condition, price, quantity: qty }]
    })
    // Keep the search results so several different cards can be rung up from one search.
  }

  // The results panel survives checkout (several customers can be rung up
  // from one search), so its stock counts must follow the goods out the door.
  function applySaleToResults(sold: SoldLine[]) {
    setResults(prev => applySaleToCardResults(prev, sold))
    setProductResults(prev => applySaleToProductResults(prev, sold))
  }

  async function handleCheckoutConfirm(opts: CheckoutConfirmOptions) {
    const { paymentMethod, payments, discountAmount, expectedTotal, customerId, cashReceived } = opts
    const body = {
      items: cart.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: i.quantity })),
      ...(payments ? { payments } : { paymentMethod }),
      discountAmount,
      expectedTotal,
      ...(customerId != null ? { customerId } : {}),
      clientUuid: crypto.randomUUID(),
    }
    // Snapshot for the receipt before the cart clears
    const lines = cart.map(i => ({ name: i.name, condition: i.condition, quantity: i.quantity, price: i.price }))
    const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0)
    let res: Response
    try {
      res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Network failure (not an HTTP error): queue for replay. The clientUuid
      // makes the replay idempotent even if this request actually landed.
      enqueueSale(body)
      setQueue(readQueue())
      applySaleToResults(body.items) // goods left the till even though the POST is queued
      setCart([])
      setCheckoutOpen(false)
      toast.info('Offline — sale queued, will send automatically when back online')
      return
    }
    if (res.ok) {
      const { saleId, total, marginNoCostCount } = await res.json()
      const changeDue = cashReceived != null ? cashReceived - total : undefined
      const data: ReceiptData = {
        saleId,
        at: new Date().toISOString(),
        shopName,
        lines,
        subtotal,
        discount: discountAmount,
        vatAmount: computeSaleTotals(subtotal, discountAmount, vatScheme).vatAmount,
        vatScheme,
        total,
        paymentMethod: paymentMethod ?? 'split',
        payments,
        cashReceived,
        changeDue,
      }
      applySaleToResults(body.items)
      setCart([])
      setCheckoutOpen(false)
      toast.success(
        changeDue != null && changeDue > 0
          ? `Sale complete — ${formatGBP(total)} · Change ${formatGBP(changeDue)}`
          : `Sale complete — ${formatGBP(total)}`,
        { action: { label: 'Receipt', onClick: () => setReceipt(data) } },
      )
      if (marginNoCostCount > 0) {
        toast.warning(`${marginNoCostCount} card(s) had no cost basis — excluded from margin VAT. Review the margin stock book.`)
      }
    } else {
      const data = await res.json().catch(() => null)
      toast.error(
        data?.code === 'PRICE_CHANGED'
          ? 'Prices changed since this search — re-search the cards and rebuild the cart'
          : data?.error ?? 'Sale failed — please try again',
      )
    }
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6" style={{ height: 'calc(100vh - 120px)' }}>
      <h1 className="sr-only">Point of Sale</h1>
      <div className="flex flex-col gap-4 overflow-y-auto">
        <SearchBar onSearch={handleSearch} onQRDetected={handleQRDetected} loading={loading} />
        {results.length === 0 && productResults.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center text-center text-sm text-muted-foreground p-8">
            <p>
              Scan a QR label or search the catalogue to begin.<br />
              <span className="text-xs">Tip: press <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted/40 font-mono text-xs">/</kbd> to jump to search from anywhere.</span>
            </p>
          </div>
        )}
        {productResults.map(p => (
          <ProductResult key={`p-${p.itemId}`} product={p.product} itemId={p.itemId}
            quantity={p.quantity} price={p.price} onAddToCart={handleAddToCart} />
        ))}
        {results.map(r => (
          <CardResult
            key={`c-${r.card.id}`}
            card={r.card}
            prices={r.prices}
            inventoryOptions={r.inventoryOptions}
            onAddToCart={handleAddToCart}
            onRefreshPrice={() => handleRefreshPrice(r.card.id)}
          />
        ))}
      </div>
      <div>
        <SaleQueue
          queue={queue}
          onRetry={uuid => {
            clearConflict(uuid)
            setQueue(readQueue())
            window.dispatchEvent(new Event('online')) // kick the replay loop now
          }}
          onDiscard={uuid => { removeSale(uuid); setQueue(readQueue()) }}
        />
        <Cart
          items={cart}
          onRemove={id => setCart(prev => prev.filter(i => i.inventoryItemId !== id))}
          onQtyChange={(id, delta) => setCart(prev => prev.map(i =>
            i.inventoryItemId === id ? { ...i, quantity: Math.max(1, i.quantity + delta) } : i
          ))}
          onCheckout={() => setCheckoutOpen(true)}
        />
      </div>
      <CheckoutDialog
        open={checkoutOpen}
        items={cart}
        onClose={() => setCheckoutOpen(false)}
        onConfirm={handleCheckoutConfirm}
      />
      <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />
    </div>
  )
}
