'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { calculateSellPrice, formatGBP } from '@/lib/pricing'
import type { Card, PriceCache } from '@/lib/db/schema'

export interface InventoryOption {
  itemId: number
  condition: string
  quantity: number
  sellPriceOverride: number | null
}

interface CardResultProps {
  card: Card
  prices: PriceCache | null
  inventoryOptions: InventoryOption[]
  onAddToCart: (itemId: number, name: string, condition: string, price: number, qty: number) => void
  onRefreshPrice: () => void
}

export function CardResult({ card, prices, inventoryOptions, onAddToCart, onRefreshPrice }: CardResultProps) {
  const [selected, setSelected] = useState<InventoryOption | null>(inventoryOptions[0] ?? null)
  const [qty, setQty] = useState(1)

  const sellPrice = selected
    ? calculateSellPrice(prices?.tcgplayerMarket, selected.sellPriceOverride)
    : null

  const hoursOld = prices
    ? (Date.now() - new Date(prices.lastSyncedAt).getTime()) / 3_600_000
    : null

  return (
    <div className="border rounded-xl p-4 space-y-3 bg-card">
      <div className="flex gap-4">
        {(card.imageUrlLarge ?? card.imageUrl) && (
          <img
            src={card.imageUrlLarge ?? card.imageUrl!}
            alt={card.name}
            className="w-24 h-32 object-contain flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold leading-tight">{card.name}</h2>
              <p className="text-sm text-muted-foreground">{card.setName} · #{card.setNumber}</p>
            </div>
            {prices?.isHighValue && hoursOld !== null && hoursOld >= 4 && (
              <Badge variant="destructive" className="shrink-0">⚠ {Math.floor(hoursOld)}h old</Badge>
            )}
          </div>
          <div className="flex gap-2 mt-2 flex-wrap items-center">
            {prices?.tcgplayerMarket != null && (
              <Badge variant="secondary">TCG {formatGBP(prices.tcgplayerMarket)}</Badge>
            )}
            {prices?.tcgplayerLow != null && (
              <Badge variant="outline">Low {formatGBP(prices.tcgplayerLow)}</Badge>
            )}
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onRefreshPrice}>
              ↻ Refresh
            </Button>
          </div>
        </div>
      </div>

      {inventoryOptions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No stock available for this card</p>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            {inventoryOptions.map(opt => (
              <button
                key={opt.itemId}
                onClick={() => { setSelected(opt); setQty(1) }}
                className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  selected?.itemId === opt.itemId
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'hover:bg-muted border-border'
                }`}
              >
                {opt.condition} · {opt.quantity} in stock
              </button>
            ))}
          </div>
          {selected && (
            <div className="flex items-center gap-3 pt-1 border-t">
              <span className="text-2xl font-bold">{formatGBP(sellPrice)}</span>
              <div className="flex items-center gap-2 ml-auto">
                <Button variant="outline" size="sm" onClick={() => setQty(q => Math.max(1, q - 1))}>−</Button>
                <span className="w-8 text-center font-semibold">{qty}</span>
                <Button variant="outline" size="sm" onClick={() => setQty(q => Math.min(selected.quantity, q + 1))}>+</Button>
                <Button
                  disabled={!sellPrice}
                  onClick={() => sellPrice && onAddToCart(selected.itemId, card.name, selected.condition, sellPrice, qty)}
                >
                  Add to Cart
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
