'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BuyCard } from '@/components/buylist/BuyCard'
import { BuyCart, BuyCartLine } from '@/components/buylist/BuyCart'
import { CatalogueBrowser, type CatalogueSelection } from '@/components/catalogue/CatalogueBrowser'
import { toast } from 'sonner'
import type { Card, PriceCache } from '@/lib/db/schema'

interface SearchResult {
  card: Card
  prices: PriceCache | null
}

type PageMode = 'search' | 'browse'

export default function BuylistPage() {
  const [pageMode, setPageMode] = useState<PageMode>('search')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [cart, setCart] = useState<BuyCartLine[]>([])

  async function handleSearch() {
    const q = query.trim()
    if (!q || loading) return
    setLoading(true)
    try {
      // Server bounds the live-API fallback at ~4s; this client timeout is a
      // backstop so the search UI can never get stuck waiting.
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json()
      const cards: Card[] = data.cards ?? []
      const prices: Record<number, PriceCache | undefined> = data.prices ?? {}
      if (!cards.length) {
        if (data.unavailable) {
          toast.error('Card search is busy right now — try that search again in a moment')
        } else {
          toast.error(`No cards found for "${q}"`)
        }
        setResults([])
        return
      }
      if (data.fuzzy) toast(`No exact match for "${q}" — showing close matches`)
      setResults(cards.map(card => ({ card, prices: prices[card.id] ?? null })))
    } catch (e) {
      toast.error(e instanceof Error && e.name === 'TimeoutError'
        ? 'Search timed out — please try again'
        : 'Search failed — please try again')
    } finally {
      setLoading(false)
    }
  }

  function handleAdd(line: BuyCartLine) {
    setCart(prev => [...prev, line])
  }

  function handleBrowseSelect({ card, prices }: CatalogueSelection) {
    setResults(prev => prev.some(r => r.card.id === card.id) ? prev : [{ card, prices }, ...prev])
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Left: search/browse + results */}
      <div className="flex flex-col gap-4 overflow-y-auto min-h-0">
        <div className="flex gap-2 shrink-0">
          <Button variant={pageMode === 'search' ? 'default' : 'outline'} onClick={() => setPageMode('search')}>
            Search
          </Button>
          <Button variant={pageMode === 'browse' ? 'default' : 'outline'} onClick={() => setPageMode('browse')}>
            Browse
          </Button>
        </div>

        {pageMode === 'search' && (
          <div className="flex gap-2 shrink-0">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search card name to buy…"
              className="h-12 text-base"
              disabled={loading}
              autoFocus
            />
            <Button className="h-12 px-6" onClick={handleSearch} disabled={loading || !query.trim()}>
              Search
            </Button>
          </div>
        )}

        {pageMode === 'browse' && (
          <div className="shrink-0" style={{ height: '360px' }}>
            <CatalogueBrowser onSelectCard={handleBrowseSelect} />
          </div>
        )}

        {results.map(({ card, prices }) => (
          <BuyCard
            key={card.id}
            card={card}
            prices={prices}
            onAdd={line => handleAdd({ ...line, cardName: card.name })}
          />
        ))}
      </div>

      {/* Right: cart */}
      <div>
        <BuyCart
          lines={cart}
          onRemove={idx => setCart(prev => prev.filter((_, i) => i !== idx))}
          onClear={() => setCart([])}
        />
      </div>
    </div>
  )
}
