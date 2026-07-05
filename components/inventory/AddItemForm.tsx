'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { parsePounds } from '@/lib/pricing'
import type { Card } from '@/lib/db/schema'

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const

export function AddItemForm() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Card[]>([])
  const [selected, setSelected] = useState<Card | null>(null)
  const [condition, setCondition] = useState('NM')
  const [quantity, setQuantity] = useState('1')
  const [costPrice, setCostPrice] = useState('')
  const [sellOverride, setSellOverride] = useState('')
  const [location, setLocation] = useState('')
  const [defectNotes, setDefectNotes] = useState('')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const router = useRouter()

  async function search() {
    if (query.trim().length < 2) return
    setSearching(true)
    const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query.trim())}`)
    const data = await res.json()
    setResults(data.cards ?? [])
    setSearching(false)
  }

  async function save() {
    if (!selected || !costPrice) return
    setSaving(true)
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId: selected.id,
        condition,
        quantity: parseInt(quantity),
        costPrice: parsePounds(costPrice), // inputs are pounds
        sellPriceOverride: sellOverride ? parsePounds(sellOverride) : null,
        location: location || null,
        defectNotes: defectNotes || null,
      }),
    })
    if (res.ok) {
      // Check for open wants matching this card
      try {
        const wantsRes = await fetch('/api/wants')
        if (wantsRes.ok) {
          const { wants } = await wantsRes.json()
          const matching = (wants as Array<{ cardId: number | null }>).filter(w => w.cardId === selected.id)
          if (matching.length > 0) {
            toast(`${matching.length} customer(s) want this card`)
          }
        }
      } catch {
        // Non-critical — swallow silently
      }
    }
    router.push('/inventory')
  }

  if (selected) {
    return (
      <div className="max-w-lg space-y-4">
        <div className="flex items-center gap-3 p-3 border rounded-lg">
          {selected.imageUrl && (
            <img src={selected.imageUrl} alt={selected.name} width={40} height={56} className="w-10 h-14 object-contain flex-shrink-0" />
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
          <div><Label htmlFor="add-item-qty">Quantity</Label><Input id="add-item-qty" name="quantity" type="number" inputMode="numeric" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} /></div>
          <div><Label htmlFor="add-item-cost">Cost Price (£)</Label><Input id="add-item-cost" name="costPrice" type="number" inputMode="decimal" step="0.01" min={0} value={costPrice} onChange={e => setCostPrice(e.target.value)} placeholder="0.00" /></div>
          <div><Label htmlFor="add-item-sell-override">Sell Override (£)</Label><Input id="add-item-sell-override" name="sellOverride" type="number" inputMode="decimal" step="0.01" min={0} value={sellOverride} onChange={e => setSellOverride(e.target.value)} placeholder="Blank = auto" /></div>
          <div><Label htmlFor="add-item-location">Location</Label><Input id="add-item-location" name="location" value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Case 3 / B7" /></div>
        </div>
        <div><Label htmlFor="add-item-defect-notes">Defect Notes</Label><Input id="add-item-defect-notes" name="defectNotes" value={defectNotes} onChange={e => setDefectNotes(e.target.value)} placeholder="e.g. Small scratch on holo" /></div>
        <Button className="w-full" onClick={save} disabled={saving || !costPrice}>
          {saving ? 'Adding…' : 'Add to Inventory'}
        </Button>
      </div>
    )
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search card name…"
          autoFocus
        />
        <Button onClick={search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
      </div>
      {results.length > 0 && (
        <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
          {results.map(card => (
            <button
              key={card.id}
              className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 text-left transition-colors"
              onClick={() => setSelected(card)}
            >
              {card.imageUrl && <img src={card.imageUrl} alt={card.name} width={40} height={56} className="w-10 h-14 object-contain flex-shrink-0" />}
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
    </div>
  )
}
