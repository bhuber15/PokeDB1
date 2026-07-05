'use client'
import { useState } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardZoomModal } from '@/components/shared/CardZoomModal'
import { useSettings } from '@/components/shared/SettingsProvider'
import { calculateBuyPrice, formatGBP } from '@/lib/pricing'
import type { Card, PriceCache } from '@/lib/db/schema'

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const
type Condition = (typeof CONDITIONS)[number]

export interface BuyLineInput {
  cardId: number
  condition: Condition
  quantity: number
  payPriceCash: number | null
  payPriceCredit: number | null
}

interface BuyCardProps {
  card: Card
  prices: PriceCache | null
  onAdd: (line: BuyLineInput) => void
}

export function BuyCard({ card, prices, onAdd }: BuyCardProps) {
  const [condition, setCondition] = useState<Condition>('NM')
  const [qty, setQty] = useState(1)
  const [zoomed, setZoomed] = useState(false)
  const { buyCashPct, buyCreditPct } = useSettings()

  const market = prices?.tcgplayerMarket
  const cashOffer = calculateBuyPrice(market, buyCashPct)
  const creditOffer = calculateBuyPrice(market, buyCreditPct)

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
          condition,
          tcgplayerMarket: market,
        } : null}
        onClose={() => setZoomed(false)}
      />
      <div className="border rounded-xl p-4 space-y-3 bg-card">
        <div className="flex gap-4">
          {(card.imageUrlLarge ?? card.imageUrl) && (
            <Image
              src={card.imageUrlLarge ?? card.imageUrl!}
              alt={card.name}
              width={96}
              height={128}
              className="w-24 h-32 object-contain flex-shrink-0 cursor-zoom-in hover:scale-105 transition-transform"
              onClick={() => setZoomed(true)}
              title="Click to zoom"
            />
          )}
          <div className="flex-1 min-w-0">
            <h2
              className="text-lg font-bold leading-tight cursor-pointer hover:text-primary transition-colors"
              onClick={() => setZoomed(true)}
            >
              {card.name}
            </h2>
            <p className="text-sm text-muted-foreground">{card.setName} · #{card.setNumber}</p>
            <div className="flex gap-2 mt-2 flex-wrap items-center">
              {market != null && (
                <Badge variant="secondary">Market {formatGBP(market)}</Badge>
              )}
              {cashOffer != null && (
                <Badge variant="outline" className="border-green-500/50 text-green-400">
                  Cash {formatGBP(cashOffer)}
                </Badge>
              )}
              {creditOffer != null && (
                <Badge variant="outline" className="border-blue-500/50 text-blue-400">
                  Credit {formatGBP(creditOffer)}
                </Badge>
              )}
              {market == null && (
                <Badge variant="destructive">No price data</Badge>
              )}
            </div>
          </div>
        </div>

        {/* Condition selector */}
        <div className="flex gap-2 flex-wrap">
          {CONDITIONS.map(c => (
            <button
              key={c}
              onClick={() => setCondition(c)}
              className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                condition === c
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'hover:bg-muted border-border'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Quantity + Add */}
        <div className="flex items-center gap-3 pt-1 border-t">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setQty(q => Math.max(1, q - 1))}>−</Button>
            <span className="w-8 text-center font-semibold">{qty}</span>
            <Button variant="outline" size="sm" onClick={() => setQty(q => q + 1)}>+</Button>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {(cashOffer != null || creditOffer != null) && (
              <span className="text-sm text-muted-foreground">
                Cash {formatGBP(cashOffer)} / Credit {formatGBP(creditOffer)}
              </span>
            )}
            <Button
              disabled={market == null}
              onClick={() => onAdd({ cardId: card.id, condition, quantity: qty, payPriceCash: cashOffer, payPriceCredit: creditOffer })}
            >
              Add to buy
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
