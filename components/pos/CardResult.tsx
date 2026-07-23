'use client'
import { useState } from 'react'
import Image from 'next/image'
import { toast } from 'sonner'
import { MinusIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { calculateSellPrice, formatGBP, marketPriceSyncedAt, parsePounds, pickMarketPrice } from '@/lib/pricing'
import { CardZoomModal } from '@/components/shared/CardZoomModal'
import { useSettings } from '@/components/shared/SettingsProvider'
import { LANGUAGE_LABELS, type Language } from '@/lib/games'
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
  onOverrideSet?: (itemId: number, sellPriceOverride: number) => void
}

export function CardResult({ card, prices, inventoryOptions, onAddToCart, onRefreshPrice, onOverrideSet }: CardResultProps) {
  // Store only the id: options are re-derived from props so a post-sale or
  // post-refresh update to the search results is reflected here immediately.
  const [selectedItemId, setSelectedItemId] = useState<number | null>(inventoryOptions[0]?.itemId ?? null)
  const [qty, setQty] = useState(1)
  const [zoomed, setZoomed] = useState(false)
  const [priceDraft, setPriceDraft] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  const { marginMultiplier, primaryPriceSource } = useSettings()

  const selected = inventoryOptions.find(o => o.itemId === selectedItemId) ?? inventoryOptions[0] ?? null
  // Stock may have shrunk under a picked qty (e.g. a sale just completed)
  const boundedQty = selected ? Math.min(qty, selected.quantity) : qty

  const sellPrice = selected
    ? calculateSellPrice(pickMarketPrice(prices, primaryPriceSource), selected.sellPriceOverride, marginMultiplier)
    : null

  // Age of the source the sell price is actually quoted from — a Cardmarket
  // refresh bumps cardmarketSyncedAt, not the sweep's lastSyncedAt.
  const syncedAt = marketPriceSyncedAt(prices, primaryPriceSource)
  const hoursOld = syncedAt != null
    // eslint-disable-next-line react-hooks/purity -- staleness badge; a fresh clock reading each render is intended
    ? (Date.now() - new Date(syncedAt).getTime()) / 3_600_000
    : null

  // No market price and no override: staff types a price at the till; it
  // persists as the item's override (the price charged is snapshotted on the
  // sale line as usual). A Cardmarket refresh would be pointless here — this
  // flow only runs when the card has no market data — so we mirror the
  // override straight into the parent's result state instead.
  async function quickSetPrice() {
    if (!selected) return
    const pence = parsePounds(priceDraft)
    if (pence <= 0) return
    setSavingPrice(true)
    try {
      const res = await fetch(`/api/inventory/${selected.itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellPriceOverride: pence }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not set price')
        return
      }
      toast.success(`Price set — ${formatGBP(pence)}`)
      setPriceDraft('')
      onOverrideSet?.(selected.itemId, pence)
    } finally {
      setSavingPrice(false)
    }
  }

  return (
    <>
      <CardZoomModal
        card={zoomed ? {
          name: card.name,
          setName: card.setName,
          setNumber: card.setNumber,
          variant: card.variant,
          imageUrlLarge: card.imageUrlLarge,
          imageUrl: card.imageUrl,
          condition: selected?.condition,
          tcgplayerMarket: prices?.tcgplayerMarket,
          cardmarketTrend: prices?.cardmarketTrend,
          sellPrice: sellPrice ?? undefined,
        } : null}
        onClose={() => setZoomed(false)}
      />
      <div className="border rounded-xl p-4 space-y-3 bg-card">
        <div className="flex gap-4">
          {(card.imageUrlLarge ?? card.imageUrl) && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              aria-label={`Zoom ${card.name}`}
              className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Image
                src={card.imageUrlLarge ?? card.imageUrl!}
                alt=""
                width={96}
                height={128}
                className="w-24 h-32 object-contain cursor-zoom-in hover:scale-105 transition-transform"
              />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold leading-tight">
                  <button
                    type="button"
                    onClick={() => setZoomed(true)}
                    className="hover:text-primary transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    {card.name}
                  </button>
                </h2>
                <p className="text-sm text-muted-foreground">{card.setName} · #{card.setNumber}</p>
                {card.language !== 'EN' && (
                  <Badge variant="outline">{LANGUAGE_LABELS[card.language as Language] ?? card.language}</Badge>
                )}
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
              {prices?.cardmarketTrend != null && (
                <Badge variant="outline">CM {formatGBP(prices.cardmarketTrend)}</Badge>
              )}
              <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={onRefreshPrice}>
                <RefreshCwIcon className="size-3" aria-hidden="true" />
                Refresh
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
                  onClick={() => { setSelectedItemId(opt.itemId); setQty(1) }}
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
            {selected && sellPrice == null ? (
              <div className="flex items-center gap-3 pt-1 border-t">
                <span className="text-sm text-muted-foreground">No price — set one to sell</span>
                <div className="ml-auto flex items-center gap-2">
                  <input
                    value={priceDraft}
                    onChange={e => setPriceDraft(e.target.value)}
                    inputMode="decimal"
                    placeholder="£0.00"
                    aria-label="Set selling price in pounds"
                    className="w-24 h-9 rounded-md border border-input bg-background px-2 text-right text-sm"
                  />
                  <Button disabled={savingPrice || parsePounds(priceDraft) <= 0} onClick={quickSetPrice}>
                    Set price
                  </Button>
                </div>
              </div>
            ) : selected && (
              <div className="flex items-center gap-3 pt-1 border-t">
                <span className="text-2xl font-bold">{formatGBP(sellPrice)}</span>
                <div className="flex items-center gap-2 ml-auto">
                  <Button variant="outline" size="sm" aria-label="Decrease quantity" onClick={() => setQty(Math.max(1, boundedQty - 1))}><MinusIcon className="size-3.5" aria-hidden="true" /></Button>
                  <span className="w-8 text-center font-semibold tabular-nums">{boundedQty}</span>
                  <Button variant="outline" size="sm" aria-label="Increase quantity" onClick={() => setQty(Math.min(selected.quantity, boundedQty + 1))}><PlusIcon className="size-3.5" aria-hidden="true" /></Button>
                  <Button
                    disabled={!sellPrice}
                    onClick={() => sellPrice && onAddToCart(selected.itemId, card.name, selected.condition, sellPrice, boundedQty)}
                  >
                    Add to Cart
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
