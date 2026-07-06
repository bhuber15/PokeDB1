'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { formatGBP, parsePounds } from '@/lib/pricing'
import type { Card } from '@/lib/db/schema'

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const

interface AddPayload {
  cardId: number
  condition: string
  quantity: number
  costPrice: number // pence
  sellPriceOverride: number | null
  location: string | null
  defectNotes: string | null
}

interface SessionAdd {
  cardName: string
  setInfo: string
  condition: string
  quantity: number
  costPrice: number // pence, per copy
}

// Rapid intake: the form never navigates away. Condition, cost and location
// stick between adds; search refocuses after each save; Ctrl/Cmd+Enter
// repeats the last add for another copy of the same card.
export function AddItemForm() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Card[]>([])
  const [highlight, setHighlight] = useState(0)
  const [selected, setSelected] = useState<Card | null>(null)
  // Sticky defaults — survive from one add to the next
  const [condition, setCondition] = useState('NM')
  const [costPrice, setCostPrice] = useState('')
  const [location, setLocation] = useState('')
  // Per-add fields
  const [quantity, setQuantity] = useState('1')
  const [sellOverride, setSellOverride] = useState('')
  const [defectNotes, setDefectNotes] = useState('')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sessionAdds, setSessionAdds] = useState<SessionAdd[]>([])

  const lastAdd = useRef<{ payload: AddPayload; display: SessionAdd } | null>(null)
  const lastSearched = useRef('')
  const searchRef = useRef<HTMLInputElement>(null)
  const costRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (selected) costRef.current?.focus()
  }, [selected])

  async function search() {
    const q = query.trim()
    if (q.length < 2) return
    setSearching(true)
    lastSearched.current = q
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`)
    const data = await res.json()
    setResults(data.cards ?? [])
    setHighlight(0)
    setSearching(false)
  }

  const submit = useCallback(async (payload: AddPayload, display: SessionAdd): Promise<boolean> => {
    setSaving(true)
    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Add failed — item not saved')
        return false
      }
      lastAdd.current = { payload, display }
      setSessionAdds(prev => [display, ...prev])
      toast.success(`Added ${display.cardName} ${display.condition} ×${display.quantity}`)
      // Non-critical: check open wants for this card
      try {
        const wantsRes = await fetch('/api/wants')
        if (wantsRes.ok) {
          const { wants } = await wantsRes.json()
          const matching = (wants as Array<{ cardId: number | null }>).filter(w => w.cardId === payload.cardId)
          if (matching.length > 0) toast(`${matching.length} customer(s) want this card`)
        }
      } catch { /* swallow */ }
      return true
    } finally {
      setSaving(false)
    }
  }, [])

  async function handleSave() {
    if (!selected || !costPrice || saving) return
    const qty = parseInt(quantity)
    if (isNaN(qty) || qty < 1) return
    const ok = await submit({
      cardId: selected.id,
      condition,
      quantity: qty,
      costPrice: parsePounds(costPrice), // inputs are pounds
      sellPriceOverride: sellOverride ? parsePounds(sellOverride) : null,
      location: location || null,
      defectNotes: defectNotes || null,
    }, {
      cardName: selected.name,
      setInfo: `${selected.setName} · #${selected.setNumber}`,
      condition,
      quantity: qty,
      costPrice: parsePounds(costPrice),
    })
    if (!ok) return
    // Back to search with sticky defaults intact; per-add fields reset
    setSelected(null)
    setQuery('')
    setResults([])
    setQuantity('1')
    setSellOverride('')
    setDefectNotes('')
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  const repeatLast = useCallback(async () => {
    if (!lastAdd.current || saving) return
    await submit(lastAdd.current.payload, lastAdd.current.display)
  }, [saving, submit])

  // Ctrl/Cmd+Enter anywhere = add another copy of the last card
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        repeatLast()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repeatLast])

  function searchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Enter searches; once results match the current query, Enter selects
      if (results.length > 0 && query.trim() === lastSearched.current) {
        setSelected(results[highlight] ?? results[0])
      } else {
        search()
      }
    }
  }

  function detailKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      setSelected(null)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }

  const totalCards = sessionAdds.reduce((n, a) => n + a.quantity, 0)
  const totalCost = sessionAdds.reduce((n, a) => n + a.costPrice * a.quantity, 0)

  return (
    <div className="flex flex-col lg:flex-row gap-8 items-start">
      <div className="w-full max-w-lg space-y-4">
        {selected ? (
          <div className="space-y-4" onKeyDown={detailKeyDown}>
            <div className="flex items-center gap-3 p-3 border rounded-lg">
              {selected.imageUrl && (
                <Image src={selected.imageUrl} alt={selected.name} width={40} height={56} className="w-10 h-14 object-contain flex-shrink-0" />
              )}
              <div className="flex-1">
                <div className="font-semibold">{selected.name}</div>
                <div className="text-sm text-muted-foreground">{selected.setName} · #{selected.setNumber}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Change</Button>
            </div>
            <div>
              <Label className="mb-2 block">Condition</Label>
              <div className="flex gap-2">
                {CONDITIONS.map(c => (
                  <Button key={c} size="sm" variant={condition === c ? 'default' : 'outline'} onClick={() => setCondition(c)}>{c}</Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="add-item-cost">Cost Price (£)</Label><Input ref={costRef} id="add-item-cost" name="costPrice" type="number" inputMode="decimal" step="0.01" min={0} value={costPrice} onChange={e => setCostPrice(e.target.value)} placeholder="0.00" /></div>
              <div><Label htmlFor="add-item-qty">Quantity</Label><Input id="add-item-qty" name="quantity" type="number" inputMode="numeric" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} /></div>
              <div><Label htmlFor="add-item-sell-override">Sell Override (£)</Label><Input id="add-item-sell-override" name="sellOverride" type="number" inputMode="decimal" step="0.01" min={0} value={sellOverride} onChange={e => setSellOverride(e.target.value)} placeholder="Blank = auto" /></div>
              <div><Label htmlFor="add-item-location">Location</Label><Input id="add-item-location" name="location" value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Case 3 / B7" /></div>
            </div>
            <div><Label htmlFor="add-item-defect-notes">Defect Notes</Label><Input id="add-item-defect-notes" name="defectNotes" value={defectNotes} onChange={e => setDefectNotes(e.target.value)} placeholder="e.g. Small scratch on holo" /></div>
            <Button className="w-full" onClick={handleSave} disabled={saving || !costPrice}>
              {saving ? 'Adding…' : 'Add to Inventory ↵'}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Enter saves · Esc back to search · condition, cost &amp; location stick for the next add
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={searchKeyDown}
                placeholder="Search card name…"
                autoFocus
              />
              <Button onClick={search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
            </div>
            {results.length > 0 && (
              <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
                {results.map((card, i) => (
                  <button
                    key={card.id}
                    className={`w-full flex items-center gap-3 p-3 text-left transition-colors ${i === highlight ? 'bg-muted/60' : 'hover:bg-muted/50'}`}
                    onClick={() => setSelected(card)}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    {card.imageUrl && <Image src={card.imageUrl} alt={card.name} width={40} height={56} className="w-10 h-14 object-contain flex-shrink-0" />}
                    <div>
                      <div className="font-medium">{card.name}</div>
                      <div className="text-sm text-muted-foreground">{card.setName} · #{card.setNumber}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {results.length === 0 && query.length > 0 && !searching && (
              <p className="text-sm text-muted-foreground">No results — try a different name</p>
            )}
            <p className="text-xs text-muted-foreground">
              ↑↓ to pick a result, Enter to select{sessionAdds.length > 0 ? ' · Ctrl/Cmd+Enter adds another copy of the last card' : ''}
            </p>
          </>
        )}
      </div>

      {/* Session progress — what's been added since the page opened */}
      <aside className="w-full lg:w-80 shrink-0 space-y-3" aria-label="Added this session">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Added this session</h2>
          {sessionAdds.length > 0 && (
            <Button size="sm" variant="outline" onClick={repeatLast} disabled={saving}>
              +1 copy of last
            </Button>
          )}
        </div>
        {sessionAdds.length === 0 ? (
          <p className="text-sm text-muted-foreground border border-dashed rounded-lg p-4 text-center">
            Nothing yet — cards you add will pile up here
          </p>
        ) : (
          <>
            <div className="border rounded-lg divide-y max-h-[28rem] overflow-y-auto">
              {sessionAdds.map((a, i) => (
                <div key={i} className="flex items-center gap-2 p-2.5 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{a.cardName}</div>
                    <div className="text-xs text-muted-foreground truncate">{a.setInfo}</div>
                  </div>
                  <Badge variant="outline" className="text-xs py-0 shrink-0">{a.condition}</Badge>
                  <span className="text-muted-foreground shrink-0">×{a.quantity}</span>
                  <span className="tabular-nums shrink-0">{formatGBP(a.costPrice)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-sm px-1">
              <span className="text-muted-foreground">{totalCards} card{totalCards !== 1 ? 's' : ''} added</span>
              <span className="font-medium tabular-nums">{formatGBP(totalCost)} cost</span>
            </div>
          </>
        )}
        <Link href="/inventory" className="block text-sm text-muted-foreground hover:text-foreground underline underline-offset-4">
          Finish → view inventory
        </Link>
      </aside>
    </div>
  )
}
