'use client'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatGBP } from '@/lib/pricing'
import type { SetSummary, CatalogueRow } from '@/lib/domain/catalogue'

// Re-exported under a name that reads naturally at the call site ("the
// thing the user selected"), while reusing the domain module's shape.
export type CatalogueSelection = CatalogueRow

interface CatalogueBrowserProps {
  onSelectCard: (selection: CatalogueSelection) => void
}

type BrowseMode = 'set' | 'name'

export function CatalogueBrowser({ onSelectCard }: CatalogueBrowserProps) {
  const [mode, setMode] = useState<BrowseMode>('set')

  const [sets, setSets] = useState<SetSummary[]>([])
  const [setFilter, setSetFilter] = useState('')
  const [activeSet, setActiveSet] = useState<string | null>(null)

  const [nameQuery, setNameQuery] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)

  const [rows, setRows] = useState<CatalogueSelection[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (mode !== 'set' || sets.length > 0) return
    fetch('/api/cards/sets').then(r => r.json()).then(d => setSets(d.sets ?? []))
  }, [mode, sets.length])

  useEffect(() => {
    if (mode !== 'name') return
    const t = setTimeout(() => {
      fetch(`/api/cards/names?q=${encodeURIComponent(nameQuery)}`)
        .then(r => r.json()).then(d => setNames(d.names ?? []))
    }, 200)
    return () => clearTimeout(t)
  }, [mode, nameQuery])

  // Timer defers the fetch past the effect's sync phase (set-state-in-effect)
  useEffect(() => {
    if (!activeSet) return
    const t = setTimeout(() => {
      setLoading(true)
      fetch(`/api/cards/browse?setName=${encodeURIComponent(activeSet)}`)
        .then(r => r.json()).then(d => setRows(d.cards ?? []))
        .finally(() => setLoading(false))
    }, 0)
    return () => clearTimeout(t)
  }, [activeSet])

  // Timer defers the fetch past the effect's sync phase (set-state-in-effect)
  useEffect(() => {
    if (!activeName) return
    const t = setTimeout(() => {
      setLoading(true)
      fetch(`/api/cards/browse-by-name?name=${encodeURIComponent(activeName)}`)
        .then(r => r.json()).then(d => setRows(d.cards ?? []))
        .finally(() => setLoading(false))
    }, 0)
    return () => clearTimeout(t)
  }, [activeName])

  const filteredSets = sets.filter(s => s.setName.toLowerCase().includes(setFilter.toLowerCase()))
  const grouped = new Map<string, SetSummary[]>()
  for (const s of filteredSets) {
    const key = s.series ?? 'Other'
    grouped.set(key, [...(grouped.get(key) ?? []), s])
  }

  function switchMode(next: BrowseMode) {
    setMode(next)
    setActiveSet(null)
    setActiveName(null)
    setRows([])
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4 h-full min-h-0">
      <div className="flex flex-col gap-3 overflow-y-auto border-r pr-3">
        <div className="flex gap-1">
          <button
            type="button"
            className={`flex-1 px-2 py-1.5 rounded-lg text-sm font-medium ${mode === 'set' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => switchMode('set')}
          >
            By Set
          </button>
          <button
            type="button"
            className={`flex-1 px-2 py-1.5 rounded-lg text-sm font-medium ${mode === 'name' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => switchMode('name')}
          >
            By Pokémon
          </button>
        </div>

        {mode === 'set' ? (
          <>
            <Input placeholder="Filter sets…" value={setFilter} onChange={e => setSetFilter(e.target.value)} />
            {[...grouped.entries()].map(([era, group]) => (
              <div key={era}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-1">{era}</div>
                {group.map(s => (
                  <button
                    type="button"
                    key={s.setName}
                    onClick={() => setActiveSet(s.setName)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm ${activeSet === s.setName ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}`}
                  >
                    {s.setName} <span className="text-muted-foreground">({s.count})</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <Input placeholder="Type a Pokémon name…" value={nameQuery} onChange={e => setNameQuery(e.target.value)} autoFocus />
            {names.map(n => (
              <button
                type="button"
                key={n}
                onClick={() => setActiveName(n)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm ${activeName === n ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}`}
              >
                {n}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="overflow-y-auto">
        {loading && <p className="text-sm text-muted-foreground p-4">Loading…</p>}
        {!loading && rows.length === 0 && (activeSet || activeName) && (
          <p className="text-sm text-muted-foreground p-4">No cards found.</p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {rows.map(({ card, prices }) => (
            <button
              type="button"
              key={card.id}
              onClick={() => onSelectCard({ card, prices })}
              className="border rounded-lg p-2 text-left hover:border-primary transition-colors bg-card"
            >
              {card.imageUrl && (
                <Image src={card.imageUrl} alt={card.name} width={120} height={168} className="w-full h-auto rounded" />
              )}
              <p className="text-xs font-semibold mt-1 truncate">{card.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{card.setName} · #{card.setNumber}</p>
              {prices?.tcgplayerMarket != null && (
                <Badge variant="secondary" className="text-[10px] mt-1">{formatGBP(prices.tcgplayerMarket)}</Badge>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
