'use client'
import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CardZoomModal, type CardZoomData } from '@/components/shared/CardZoomModal'
import { formatGBP, usdToGbp } from '@/lib/pricing'
import { useSettings } from '@/components/shared/SettingsProvider'
import type { PokemonTCGCard, AllPrices } from '@/lib/apis/pokemon-tcg'

type PriceRow = { market?: number; low?: number; mid?: number; high?: number }
// TCG prices are USD — convert each field to GBP for display at the shop's rate
function toGbpRow(p: PriceRow, rate: number): PriceRow {
  return {
    market: usdToGbp(p.market, rate) ?? undefined,
    low: usdToGbp(p.low, rate) ?? undefined,
    mid: usdToGbp(p.mid, rate) ?? undefined,
    high: usdToGbp(p.high, rate) ?? undefined,
  }
}

const VARIANT_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holo',
  '1stEditionHolofoil': '1st Ed. Holo',
  '1stEditionNormal': '1st Ed. Normal',
}

function PriceBlock({ label, p }: { label: string; p: { market?: number; low?: number; mid?: number; high?: number } }) {
  return (
    <div className="bg-muted/30 rounded-lg p-2.5 min-w-[100px]">
      <div className="text-xs text-muted-foreground mb-1.5 font-medium">{label}</div>
      <div className="space-y-0.5 text-xs">
        {p.market != null && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Market</span><span className="font-bold text-foreground">{formatGBP(p.market)}</span></div>}
        {p.low != null && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Low</span><span>{formatGBP(p.low)}</span></div>}
        {p.mid != null && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Mid</span><span>{formatGBP(p.mid)}</span></div>}
        {p.high != null && <div className="flex justify-between gap-3"><span className="text-muted-foreground">High</span><span>{formatGBP(p.high)}</span></div>}
      </div>
    </div>
  )
}

function CardPriceRow({ card, onZoom }: { card: PokemonTCGCard; onZoom: (c: CardZoomData) => void }) {
  const { usdToGbp: rate } = useSettings()
  const prices: AllPrices = card.tcgplayer?.prices ?? {}
  // Convert each variant's USD prices to GBP up front
  const variants = (Object.entries(prices) as [string, PriceRow][])
    .map(([k, p]) => [k, toGbpRow(p, rate)] as [string, PriceRow])
  const bestMarket = variants.map(([, p]) => p.market ?? 0).reduce((a, b) => Math.max(a, b), 0) || null

  return (
    <div className="border border-border rounded-xl p-4 bg-card hover:border-border/80 transition-colors">
      <div className="flex gap-4">
        {/* Card image */}
        <div className="shrink-0">
          <img
            src={card.images.small}
            alt={card.name}
            className="w-16 rounded-lg cursor-zoom-in hover:scale-110 transition-transform shadow-md"
            onClick={() => onZoom({
              name: card.name,
              setName: card.set.name,
              setNumber: card.number,
              variant: card.subtypes?.join(' / '),
              imageUrlLarge: card.images.large,
              imageUrl: card.images.small,
              tcgplayerMarket: bestMarket,
            })}
          />
        </div>

        {/* Card info */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <h3
                className="font-bold text-base leading-tight cursor-pointer hover:text-primary transition-colors"
                onClick={() => onZoom({
                  name: card.name,
                  setName: card.set.name,
                  setNumber: card.number,
                  variant: card.subtypes?.join(' / '),
                  imageUrlLarge: card.images.large,
                  imageUrl: card.images.small,
                  tcgplayerMarket: bestMarket,
                })}
              >
                {card.name}
              </h3>
              <p className="text-sm text-muted-foreground">{card.set.name} · #{card.number}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              {card.rarity && <Badge variant="outline" className="text-xs">{card.rarity}</Badge>}
              {card.types?.map(t => (
                <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
              ))}
              {bestMarket && (
                <span className="text-lg font-bold text-primary">{formatGBP(bestMarket)}</span>
              )}
              {!bestMarket && (
                <span className="text-sm text-muted-foreground italic">No price data</span>
              )}
            </div>
          </div>

          {/* Price variants */}
          {variants.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {variants.map(([variant, p]) => (
                <PriceBlock key={variant} label={VARIANT_LABELS[variant] ?? variant} p={p} />
              ))}
            </div>
          )}

          {/* Subtypes */}
          {card.subtypes && card.subtypes.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {card.subtypes.map(s => (
                <span key={s} className="text-xs text-accent font-medium">{s}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function PricesPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PokemonTCGCard[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [zoomCard, setZoomCard] = useState<CardZoomData | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [error, setError] = useState('')

  async function search(q = query) {
    if (q.trim().length < 2) return
    setLoading(true)
    setSearched(true)
    setError('')
    try {
      const res = await fetch(`/api/prices/search?q=${encodeURIComponent(q.trim())}`)
      if (!res.ok) {
        setError('Price lookup failed — the card API may be unavailable. Try again.')
        setResults([])
        return
      }
      const data = await res.json()
      setResults(data.cards ?? [])
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <CardZoomModal card={zoomCard} onClose={() => setZoomCard(null)} />
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Price Lookup</h1>
          <p className="text-sm text-muted-foreground mt-1">Search the full Pokemon TCG catalogue · prices converted from USD to GBP</p>
        </div>

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 max-w-xl">
            {error}
          </p>
        )}

        {/* Search bar */}
        <div className="flex gap-2 max-w-xl">
          <Input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search any card — e.g. Charizard, Pikachu, Mewtwo…"
            className="h-10"
            autoFocus
          />
          <Button onClick={() => search()} disabled={loading || query.trim().length < 2} className="h-10 px-6">
            {loading ? '…' : 'Search'}
          </Button>
        </div>

        {/* Results */}
        {loading && (
          <div className="grid gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="border border-border rounded-xl p-4 bg-card animate-pulse h-28" />
            ))}
          </div>
        )}

        {!loading && searched && results.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-lg">No cards found for &ldquo;{query}&rdquo;</p>
            <p className="text-sm mt-1">Try a different name or check your spelling</p>
          </div>
        )}

        {!loading && results.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">{results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;</p>
            <div className="grid gap-3">
              {results.map(card => (
                <CardPriceRow key={card.id} card={card} onZoom={setZoomCard} />
              ))}
            </div>
          </>
        )}

        {!searched && (
          <div className="text-center py-20 text-muted-foreground space-y-2">
            <div className="text-4xl">🔍</div>
            <p className="text-base font-medium">Search any Pokémon card</p>
            <p className="text-sm">See market, low, mid and high prices across all variants</p>
          </div>
        )}
      </div>
    </>
  )
}
