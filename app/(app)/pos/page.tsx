'use client'
import { useState } from 'react'
import { SearchBar } from '@/components/pos/SearchBar'
import { CardResult, InventoryOption } from '@/components/pos/CardResult'
import { Cart, CartItem } from '@/components/pos/Cart'
import { CheckoutDialog } from '@/components/pos/CheckoutDialog'
import { toast } from 'sonner'
import { formatGBP } from '@/lib/pricing'
import type { Card, PriceCache } from '@/lib/db/schema'

interface SearchState {
  card: Card
  prices: PriceCache | null
  inventoryOptions: InventoryOption[]
}

interface InvRow {
  item: { id: number; cardId: number | null; condition: string; quantity: number; sellPriceOverride: number | null }
  card: Card | null
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

export default function POSPage() {
  const [results, setResults] = useState<SearchState[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSearch(query: string) {
    setLoading(true)
    const res = await fetch(`/api/inventory?q=${encodeURIComponent(query)}`)
    const rows = (await res.json()) as InvRow[]
    const grouped = groupByCard(rows)
    if (grouped.length === 0) {
      toast.error(`No in-stock cards found for "${query}"`)
      setResults([])
      setLoading(false)
      return
    }
    setResults(grouped)
    setLoading(false)
  }

  async function handleQRDetected(qrCode: string) {
    setLoading(true)
    const res = await fetch(`/api/inventory?qrCode=${encodeURIComponent(qrCode)}`)
    const rows = (await res.json()) as InvRow[]
    const grouped = groupByCard(rows)
    if (grouped.length === 0) {
      toast.error('QR code not found in inventory')
      setResults([])
      setLoading(false)
      return
    }
    setResults(grouped)
    setLoading(false)
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

  async function handleCheckoutConfirm(paymentMethod: string, discountAmount: number, expectedTotal: number, customerId?: number) {
    let res: Response
    try {
      res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: i.quantity })),
          paymentMethod,
          discountAmount,
          expectedTotal,
          ...(customerId != null ? { customerId } : {}),
        }),
      })
    } catch {
      toast.error('Network error — check Reports → Recent Sales before retrying, the sale may have gone through')
      return
    }
    if (res.ok) {
      const { total } = await res.json()
      setCart([])
      setCheckoutOpen(false)
      toast.success(`Sale complete — ${formatGBP(total)}`)
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
      <div className="flex flex-col gap-4 overflow-y-auto">
        <SearchBar onSearch={handleSearch} onQRDetected={handleQRDetected} loading={loading} />
        {results.map(r => (
          <CardResult
            key={r.card.id}
            card={r.card}
            prices={r.prices}
            inventoryOptions={r.inventoryOptions}
            onAddToCart={handleAddToCart}
            onRefreshPrice={() => toast.info('Live price refresh coming in Phase 4')}
          />
        ))}
      </div>
      <div>
        <Cart
          items={cart}
          onRemove={id => setCart(prev => prev.filter(i => i.inventoryItemId !== id))}
          onCheckout={() => setCheckoutOpen(true)}
        />
      </div>
      <CheckoutDialog
        open={checkoutOpen}
        items={cart}
        onClose={() => setCheckoutOpen(false)}
        onConfirm={handleCheckoutConfirm}
      />
    </div>
  )
}
