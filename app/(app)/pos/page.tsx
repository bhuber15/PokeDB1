'use client'
import { useState } from 'react'
import { SearchBar } from '@/components/pos/SearchBar'
import { CardResult, InventoryOption } from '@/components/pos/CardResult'
import { Cart, CartItem } from '@/components/pos/Cart'
import { CheckoutDialog } from '@/components/pos/CheckoutDialog'
import { toast } from 'sonner'
import type { Card, PriceCache } from '@/lib/db/schema'

interface SearchState {
  card: Card
  prices: PriceCache | null
  inventoryOptions: InventoryOption[]
}

export default function POSPage() {
  const [result, setResult] = useState<SearchState | null>(null)
  const [cart, setCart] = useState<CartItem[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  async function loadCardWithInventory(cardId: number, allRows: Record<string, unknown>[]) {
    const row0 = allRows[0] as { card: Card; prices: PriceCache | null } | undefined
    setResult({
      card: row0?.card ?? ({ id: cardId } as Card),
      prices: row0?.prices ?? null,
      inventoryOptions: allRows
        .map((r: Record<string, unknown>) => {
          const item = r.item as { id: number; condition: string; quantity: number; sellPriceOverride: number | null }
          return { itemId: item.id, condition: item.condition, quantity: item.quantity, sellPriceOverride: item.sellPriceOverride }
        })
        .filter((o: InventoryOption) => o.quantity > 0),
    })
  }

  async function handleSearch(query: string) {
    setLoading(true)
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`)
    const data = await res.json()
    if (!data.cards?.length) {
      toast.error(`No cards found for "${query}"`)
      setLoading(false)
      return
    }
    const card = data.cards[0] as Card
    const invRes = await fetch(`/api/inventory?cardId=${card.id}`)
    const rows = await invRes.json()
    await loadCardWithInventory(card.id, rows)
    setLoading(false)
  }

  async function handleQRDetected(qrCode: string) {
    setLoading(true)
    const res = await fetch(`/api/inventory?qrCode=${encodeURIComponent(qrCode)}`)
    const rows = await res.json()
    if (!rows.length) {
      toast.error('QR code not found in inventory')
      setLoading(false)
      return
    }
    const { card } = rows[0] as { card: Card }
    await loadCardWithInventory(card.id, rows)
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
    setResult(null)
  }

  async function handleCheckoutConfirm(paymentMethod: string, discountAmount: number) {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: i.quantity, priceAtSale: i.price })),
        paymentMethod,
        discountAmount,
      }),
    })
    if (res.ok) {
      const { total } = await res.json()
      setCart([])
      setCheckoutOpen(false)
      toast.success(`Sale complete — £${total.toFixed(2)}`)
    } else {
      toast.error('Sale failed — please try again')
    }
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex flex-col gap-4 overflow-y-auto">
        <SearchBar onSearch={handleSearch} onQRDetected={handleQRDetected} loading={loading} />
        {result && (
          <CardResult
            card={result.card}
            prices={result.prices}
            inventoryOptions={result.inventoryOptions}
            onAddToCart={handleAddToCart}
            onRefreshPrice={() => toast.info('Live price refresh coming in Phase 4')}
          />
        )}
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
