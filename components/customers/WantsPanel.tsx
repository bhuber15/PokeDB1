'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

interface Want {
  id: number
  customerId: number
  cardId: number | null
  freeText: string | null
  notify: boolean
  createdAt: string
  customerName: string | null
  cardName: string | null
  cardSetName: string | null
  cardSetNumber: string | null
  inStock: boolean
}

// All outstanding wants across every customer — "what should I pull from new stock".
export function WantsPanel() {
  const [wants, setWants] = useState<Want[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/wants')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setWants(data.wants ?? [])
    } catch {
      toast.error('Could not load want list')
    } finally {
      setLoading(false)
    }
  }, [])

  // Timer defers the fetch past the effect's sync phase (set-state-in-effect)
  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load])

  async function markDone(id: number) {
    try {
      const res = await fetch(`/api/wants?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setWants(prev => prev.filter(w => w.id !== id))
      toast.success('Want removed')
    } catch {
      toast.error('Could not remove want')
    }
  }

  const cardLabel = (w: Want) => {
    if (w.cardName) {
      return `${w.cardName}${w.cardSetName ? ` — ${w.cardSetName}` : ''}${w.cardSetNumber ? ` #${w.cardSetNumber}` : ''}`
    }
    return w.freeText ?? '(unknown)'
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Open customer wants — green = in stock now</p>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : wants.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">No open wants</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                {['Customer', 'Card / Item', 'Status', ''].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wants.map(w => (
                <tr key={w.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/customers/${w.customerId}`} className="hover:underline">
                      {w.customerName ?? `Customer #${w.customerId}`}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={w.inStock ? 'text-emerald-400 font-medium' : ''}>
                      {cardLabel(w)}
                    </span>
                    {w.freeText && w.cardName == null && (
                      <span className="ml-1.5 text-xs text-muted-foreground">(free text)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {w.inStock ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                        In stock
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted/50 border border-border px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block" />
                        Not in stock
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {w.inStock && w.cardName && (
                      <Link
                        href={`/pos?q=${encodeURIComponent(w.cardName)}`}
                        className="inline-flex items-center text-xs font-semibold text-emerald-400 hover:underline mr-3"
                      >
                        Sell →
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => markDone(w.id)}
                    >
                      Done / Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
