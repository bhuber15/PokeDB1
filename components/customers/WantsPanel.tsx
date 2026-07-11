'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { groupInStockWants, cardLabel, type WantRow } from '@/lib/wants-grouping'

// Shop-wide want list: a proactive "in stock now" section (who to call) plus
// the full open list underneath.
export function WantsPanel() {
  const [wants, setWants] = useState<WantRow[]>([])
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

  const inStockGroups = useMemo(() => groupInStockWants(wants), [wants])

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

  async function toggleNotify(id: number, notify: boolean) {
    setWants(prev => prev.map(w => (w.id === id ? { ...w, notify } : w)))
    try {
      const res = await fetch(`/api/wants?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setWants(prev => prev.map(w => (w.id === id ? { ...w, notify: !notify } : w)))
      toast.error('Could not update notify')
    }
  }

  return (
    <div className="space-y-6">
      {/* In stock now — ready to sell */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">In stock now — ready to sell</h2>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border">Loading…</div>
        ) : inStockGroups.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border">
            No wanted cards are in stock right now
          </div>
        ) : (
          <div className="space-y-3">
            {inStockGroups.map(group => (
              <div key={group.cardId} className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-emerald-400/20">
                  <span className="font-medium text-emerald-300">{group.label}</span>
                  <Link
                    href={`/pos?q=${encodeURIComponent(group.cardName ?? group.label)}`}
                    className="text-xs font-semibold text-emerald-400 hover:underline"
                  >
                    Sell →
                  </Link>
                </div>
                <ul className="divide-y divide-border/40">
                  {group.customers.map(c => (
                    <li key={c.wantId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <Link href={`/customers/${c.customerId}`} className="font-medium hover:underline">
                          {c.name ?? `Customer #${c.customerId}`}
                        </Link>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 mt-0.5">
                          <span>{c.phone ?? 'no phone'}</span>
                          <span>{c.email ?? 'no email'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                          <input
                            type="checkbox"
                            checked={c.notify}
                            onChange={e => toggleNotify(c.wantId, e.target.checked)}
                          />
                          Notify
                        </label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => markDone(c.wantId)}
                        >
                          Mark fulfilled
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Full open list */}
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">All open customer wants — green = in stock now</p>
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
      </section>
    </div>
  )
}
