'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BuyCard } from '@/components/buylist/BuyCard'
import { BuyCart, BuyCartLine } from '@/components/buylist/BuyCart'
import { toast } from 'sonner'
import type { Card, PriceCache } from '@/lib/db/schema'

interface SearchResult {
  card: Card
  prices: PriceCache | null
}

export default function BuylistPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [cart, setCart] = useState<BuyCartLine[]>([])

  async function handleSearch() {
    const q = query.trim()
    if (!q) return
    setLoading(true)
    try {
      const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      const cards: Card[] = data.cards ?? []
      if (!cards.length) {
        toast.error(`No cards found for "${q}"`)
        setResults([])
        return
      }
      // Fetch prices for each card (up to 10 results)
      const slice = cards.slice(0, 10)
      const withPrices = await Promise.all(
        slice.map(async (card) => {
          try {
            const pr = await fetch(`/api/cards/${card.id}`)
            if (!pr.ok) return { card, prices: null }
            const d = await pr.json()
            return { card, prices: (d.priceCache ?? null) as PriceCache | null }
          } catch {
            return { card, prices: null }
          }
        })
      )
      setResults(withPrices)
    } catch {
      toast.error('Search failed — please try again')
    } finally {
      setLoading(false)
    }
  }

  function handleAdd(line: BuyCartLine) {
    setCart(prev => [...prev, line])
  }

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Left: search + results */}
      <div className="flex flex-col gap-4 overflow-y-auto">
        <div className="flex gap-2">
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
