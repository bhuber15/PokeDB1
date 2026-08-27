'use client'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BuyCard } from '@/components/buylist/BuyCard'
import { BuyCart, BuyCartLine } from '@/components/buylist/BuyCart'
import { ProductBuyRow } from '@/components/buylist/ProductBuyRow'
import { CatalogueBrowser, type CatalogueSelection } from '@/components/catalogue/CatalogueBrowser'
import { GameFilter } from '@/components/shared/GameFilter'
import { useStickyGameFilter } from '@/components/shared/useStickyGameFilter'
import { toast } from 'sonner'
import { isCardmarketFresh } from '@/lib/pricing'
import type { Card, PriceCache, Product } from '@/lib/db/schema'

interface SearchResult {
  card: Card
  prices: PriceCache | null
}

type PageMode = 'search' | 'browse'

export default function BuylistPage() {
  const [pageMode, setPageMode] = useState<PageMode>('search')
  const [gameFilter, setGameFilter] = useStickyGameFilter('buylist')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [productResults, setProductResults] = useState<Product[]>([])
  const [cart, setCart] = useState<BuyCartLine[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  // Browse selections land in a BuyCard below the fixed browse panel — often
  // below the fold — and re-selecting a card already in the list is deduped to
  // a no-op. Without feedback both read as dead clicks, so every selection
  // scrolls the card's BuyCard into view and flashes it. `seq` bumps per click
  // so re-selecting the same card re-triggers the effect.
  const [flash, setFlash] = useState<{ cardId: number; seq: number } | null>(null)
  const buyCardRefs = useRef(new Map<number, HTMLDivElement>())

  useEffect(() => {
    if (!flash) return
    buyCardRefs.current.get(flash.cardId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t = setTimeout(() => setFlash(null), 1500)
    return () => clearTimeout(t)
  }, [flash])

  // The input is disabled while a search runs, which permanently drops focus
  // when it re-enables — so typing (and Enter) after the first search went
  // nowhere until the box was clicked again. Refocus like the POS box does.
  useEffect(() => {
    if (!loading && pageMode === 'search') searchRef.current?.focus()
  }, [loading, pageMode])

  async function handleSearch() {
    const q = query.trim()
    if (!q || loading) return
    setLoading(true)
    try {
      // Server bounds the live-API fallback at ~4s; this client timeout is a
      // backstop so the search UI can never get stuck waiting.
      const gameQ = gameFilter !== 'all' ? `&game=${gameFilter}` : ''
      const [res, invRes] = await Promise.all([
        fetch(`/api/cards/search?q=${encodeURIComponent(q)}${gameQ}`, { signal: AbortSignal.timeout(15_000) }),
        fetch(`/api/inventory?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) }),
      ])
      const data = await res.json()
      const cards: Card[] = data.cards ?? []
      const prices: Record<number, PriceCache | undefined> = data.prices ?? {}
      const invRows: { product: Product | null }[] = invRes.ok ? await invRes.json() : []
      const productRows = invRows.filter(r => r.product != null).map(r => r.product!)
      setProductResults(productRows)
      if (!cards.length && !productRows.length) {
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
      if (!navigator.onLine) {
        toast.error('Offline — buys need a connection and are not queued.')
      } else {
        toast.error(e instanceof Error && e.name === 'TimeoutError'
          ? 'Search timed out — please try again'
          : 'Search failed — please try again')
      }
    } finally {
      setLoading(false)
    }
  }

  function handleAdd(line: BuyCartLine) {
    setCart(prev => [...prev, line])
  }

  function handleBrowseSelect({ card, prices }: CatalogueSelection) {
    setResults(prev => prev.some(r => r.card.id === card.id) ? prev : [{ card, prices }, ...prev])
    setFlash(f => ({ cardId: card.id, seq: (f?.seq ?? 0) + 1 }))
    // Browse rows come straight from the local cache; for cards we've never
    // stocked there's usually no Cardmarket entry, so the offer would quietly
    // be priced off TCGplayer USD. Refresh it and swap the prices in.
    // (Search results get the same treatment server-side in searchCards.)
    if (card.externalId && !isCardmarketFresh(prices?.cardmarketSyncedAt)) {
      fetch(`/api/prices/cardmarket?cardId=${card.id}`)
        .then(res => (res.ok ? res.json() : null))
        .then((data: { prices?: PriceCache | null } | null) => {
          if (data?.prices) {
            setResults(prev => prev.map(r => (r.card.id === card.id ? { ...r, prices: data.prices! } : r)))
          }
        })
        .catch(() => {})
    }
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
          <div className="flex flex-col gap-2 shrink-0">
            <div className="flex gap-2">
              <Input
                ref={searchRef}
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
            <GameFilter value={gameFilter} onChange={setGameFilter} />
          </div>
        )}

        {pageMode === 'browse' && (
          <div className="shrink-0" style={{ height: '360px' }}>
            <CatalogueBrowser onSelectCard={handleBrowseSelect} />
          </div>
        )}

        {productResults.map(p => (
          <ProductBuyRow key={`p-${p.id}`} product={p} onAdd={handleAdd} />
        ))}

        {results.map(({ card, prices }) => (
          <div
            key={card.id}
            ref={el => {
              if (!el) return
              buyCardRefs.current.set(card.id, el)
              return () => { buyCardRefs.current.delete(card.id) }
            }}
            className={`rounded-xl transition-shadow ${flash?.cardId === card.id ? 'ring-2 ring-primary' : ''}`}
          >
            <BuyCard
              card={card}
              prices={prices}
              onAdd={line => handleAdd({ ...line, cardName: card.name })}
            />
          </div>
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
