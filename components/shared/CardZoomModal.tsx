'use client'
import { useEffect } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatGBP } from '@/lib/pricing'

export interface CardZoomData {
  name: string
  setName: string
  setNumber: string
  variant?: string | null
  imageUrlLarge?: string | null
  imageUrl?: string | null
  condition?: string
  tcgplayerMarket?: number | null
  sellPrice?: number | null
}

interface CardZoomModalProps {
  card: CardZoomData | null
  onClose: () => void
}

const CONDITION_COLOURS: Record<string, string> = {
  NM: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  LP: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  MP: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  HP: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  DMG: 'bg-red-500/20 text-red-300 border-red-500/30',
}

export function CardZoomModal({ card, onClose }: CardZoomModalProps) {
  useEffect(() => {
    if (!card) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, onClose])

  if (!card) return null

  const img = card.imageUrlLarge ?? card.imageUrl

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col sm:flex-row gap-6 bg-card border border-border rounded-2xl p-6 max-w-lg w-full shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <XIcon className="size-5" aria-hidden="true" />
        </button>

        {img && (
          <div className="flex justify-center sm:block shrink-0">
            <img
              src={img}
              alt={card.name}
              width={176}
              height={246}
              className="w-44 rounded-xl shadow-lg"
            />
          </div>
        )}

        <div className="flex flex-col justify-center gap-3 min-w-0">
          <div>
            <h2 className="text-xl font-bold leading-tight">{card.name}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{card.setName} · #{card.setNumber}</p>
            {card.variant && (
              <p className="text-xs text-accent font-medium mt-1">{card.variant}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {card.condition && (
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${CONDITION_COLOURS[card.condition] ?? 'bg-muted text-muted-foreground border-border'}`}>
                {card.condition}
              </span>
            )}
            {card.tcgplayerMarket != null && (
              <Badge variant="secondary" className="text-xs">
                TCG {formatGBP(card.tcgplayerMarket)}
              </Badge>
            )}
            {card.sellPrice != null && (
              <Badge className="text-xs bg-primary text-primary-foreground">
                Sell {formatGBP(card.sellPrice)}
              </Badge>
            )}
          </div>

          <p className="text-xs text-muted-foreground">Click outside or press Esc to close</p>
        </div>
      </div>
    </div>
  )
}
