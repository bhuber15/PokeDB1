'use client'
import { useState, useRef } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CardZoomModal, type CardZoomData } from '@/components/shared/CardZoomModal'
import { formatGBP, pickMarketPrice, pickMarketSource } from '@/lib/pricing'
import { useSettings } from '@/components/shared/SettingsProvider'
import { GAMES, type Game } from '@/lib/games'
import type { Card, PriceCache } from '@/lib/db/schema'

// Catalogue-first price lookup: cards + cached market prices come from
// /api/cards/search — the same cascade as the buylist — with the shop's
// primary source (Cardmarket EUR→GBP) leading and TCGplayer USD→GBP as the
// fallback. Search also refreshes stale Cardmarket entries for the top
// results server-side, so quotes fill in live while TCGdex is reachable.

// A cached 0 is TCGdex's "no data" artifact, never a real price — hide it.
function shown(v: number | null | undefined): v is number {
  return v != null && v !== 0
}

function PriceBlock({ label, rows }: { label: string; rows: [string, number | null | undefined][] }) {
  if (!rows.some(([, v]) => shown(v))) return null
  return (
    <div className="bg-muted/30 rounded-lg p-2.5 min-w-[110px]">
      <div className="text-xs text-muted-foreground mb-1.5 font-medium">{label}</div>
      <div className="space-y-0.5 text-xs">
        {rows.map(([k, v]) => shown(v) && (
          <div key={k} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{k}</span>
            <span className={k === 'Trend' || k === 'Market' ? 'font-bold text-foreground' : undefined}>{formatGBP(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CardPriceRow({ card, prices, onZoom }: { card: Card; prices: PriceCache | null; onZoom: (c: CardZoomData) => void }) {
  const { primaryPriceSource } = useSettings()
  const headline = pickMarketPrice(prices, primaryPriceSource)
  const source = pickMarketSource(prices, primaryPriceSource)
  const zoomData: CardZoomData = {
    name: card.name,
    setName: card.setName,
    setNumber: card.setNumber,
    variant: card.variant,
    imageUrlLarge: card.imageUrlLarge,
    imageUrl: card.imageUrl,
    tcgplayerMarket: prices?.tcgplayerMarket,
    cardmarketTrend: prices?.cardmarketTrend,
  }
  return (
    <div className="border border-border rounded-xl p-4 bg-card hover:border-border/80 transition-colors">
      <div className="flex gap-4">
        {card.imageUrl && (
          <button
            type="button"
            className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Zoom ${card.name}`}
            onClick={() => onZoom(zoomData)}
          >
            <Image
              src={card.imageUrl}
              alt=""
              width={64}
              height={89}
              className="w-16 rounded-lg cursor-zoom-in hover:scale-110 transition-transform shadow-md"
            />
          </button>
        )}

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <h3 className="font-bold text-base leading-tight">
                <button
                  type="button"
                  className="hover:text-primary transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  onClick={() => onZoom(zoomData)}
                >
                  {card.name}
                </button>
              </h3>
              <p className="text-sm text-muted-foreground">{card.setName} · #{card.setNumber}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <Badge variant="secondary" className="text-xs">{GAMES[card.game as Game]?.label ?? card.game}</Badge>
              {card.variant && <Badge variant="outline" className="text-xs">{card.variant}</Badge>}
              {headline != null && (
                <span className="text-lg font-bold text-primary">{formatGBP(headline)}</span>
              )}
              {headline != null && source === 'tcgplayer' && primaryPriceSource === 'cardmarket' && (
                <Badge variant="outline" className="text-xs">USD fallback</Badge>
              )}
              {headline == null && (
                <span className="text-sm text-muted-foreground italic">No price data</span>
              )}
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <PriceBlock
              label="Cardmarket (EUR→GBP)"
              rows={[['Trend', prices?.cardmarketTrend], ['Low', prices?.cardmarketLow], ['Avg', prices?.cardmarketAvg]]}
            />
            <PriceBlock
              label="TCGplayer (USD→GBP)"
              rows={[['Market', prices?.tcgplayerMarket], ['Low', prices?.tcgplayerLow], ['Mid', prices?.tcgplayerMid], ['High', prices?.tcgplayerHigh]]}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PricesPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ card: Card; prices: PriceCache | null }[]>([])
  const [fuzzy, setFuzzy] = useState(false)
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
    setFuzzy(false)
    try {
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q.trim())}`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        setError('Price lookup failed — please sign in again and retry.')
        setResults([])
        return
      }
      const data = await res.json()
      const cards: Card[] = data.cards ?? []
      const prices: Record<number, PriceCache | undefined> = data.prices ?? {}
      if (cards.length === 0 && data.unavailable) {
        setError('The card price service is busy right now — try that search again in a moment.')
        setResults([])
        return
      }
      setFuzzy(Boolean(data.fuzzy))
      setResults(cards.map(card => ({ card, prices: prices[card.id] ?? null })))
    } catch (e) {
      setResults([])
      setError(e instanceof Error && e.name === 'TimeoutError'
        ? 'Search timed out — please try again.'
        : 'Could not reach the server. Check your connection and try again.')
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
          <p className="text-sm text-muted-foreground mt-1">
            Search the full catalogue · Cardmarket (EUR→GBP) first, TCGplayer (USD→GBP) fallback
          </p>
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
            placeholder="Search any card — e.g. Charizard, Black Lotus, Blue-Eyes…"
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

        {!loading && searched && !error && results.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-lg">No cards found for &ldquo;{query}&rdquo;</p>
            <p className="text-sm mt-1">Try a different name or check your spelling</p>
          </div>
        )}

        {!loading && results.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">
              {fuzzy
                ? <>No exact match for &ldquo;{query}&rdquo; — showing close matches</>
                : <>{results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;</>}
            </p>
            <div className="grid gap-3">
              {results.map(({ card, prices }) => (
                <CardPriceRow key={card.id} card={card} prices={prices} onZoom={setZoomCard} />
              ))}
            </div>
          </>
        )}

        {!searched && (
          <div className="text-center py-20 text-muted-foreground space-y-2">
            <div className="text-4xl">🔍</div>
            <p className="text-base font-medium">Search any card in the catalogue</p>
            <p className="text-sm">Cardmarket and TCGplayer prices, shown in GBP</p>
          </div>
        )}
      </div>
    </>
  )
}
