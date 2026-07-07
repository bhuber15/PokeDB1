'use client'
import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { formatGBP } from '@/lib/pricing'
import type { Customer } from '@/lib/db/schema'

interface CustomerPickerProps {
  onSelect: (customer: Customer | null) => void
  selected?: Customer | null
}

export function CustomerPicker({ onSelect, selected }: CustomerPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newName, setNewName] = useState('')
  const [balanceInfo, setBalanceInfo] = useState<{ customerId: number; balance: number | null } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Balance/loading are derived from balanceInfo so a slow response for a
  // previously selected customer can never show against the current one
  const balance = selected && balanceInfo?.customerId === selected.id ? balanceInfo.balance : null
  const loadingBalance = !!selected && balanceInfo?.customerId !== selected.id

  // Fetch balance when selected customer changes
  useEffect(() => {
    const id = selected?.id
    if (id == null) return
    let stale = false
    fetch(`/api/customers/${id}`)
      .then(r => r.json())
      .then((data: { balance: number }) => { if (!stale) setBalanceInfo({ customerId: id, balance: data.balance ?? null }) })
      .catch(() => { if (!stale) setBalanceInfo({ customerId: id, balance: null }) })
    return () => { stale = true }
  }, [selected?.id])

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function search(q: string) {
    setQuery(q)
    if (!q.trim()) { setResults([]); setOpen(false); return }
    try {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`)
      const data: Customer[] = await res.json()
      setResults(data)
      setOpen(true)
    } catch {
      setResults([])
    }
  }

  function pick(c: Customer) {
    onSelect(c)
    setQuery('')
    setResults([])
    setOpen(false)
    setCreating(false)
  }

  async function createCustomer() {
    const name = newName.trim()
    if (!name || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        toast.error('Failed to create customer')
        return
      }
      const c: Customer = await res.json()
      toast.success(`Customer "${c.name}" created`)
      pick(c)
      setNewName('')
    } catch {
      toast.error('Failed to create customer — check your connection')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 bg-muted/30">
          <div>
            <span className="font-medium">{selected.name}</span>
            {loadingBalance ? (
              <span className="ml-2 text-xs text-muted-foreground">Loading balance…</span>
            ) : balance !== null ? (
              <span className="ml-2 text-xs text-muted-foreground">Balance: {formatGBP(balance)}</span>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Input
            value={query}
            onChange={e => search(e.target.value)}
            onFocus={() => query && setOpen(true)}
            placeholder="Search customer by name…"
            className="h-9"
          />
          {open && (
            <div className="absolute z-30 mt-1 w-full rounded-lg border bg-popover shadow-md overflow-hidden">
              {results.map(c => (
                <button
                  key={c.id}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                  onClick={() => pick(c)}
                >
                  {c.name}
                  {c.phone && <span className="ml-2 text-muted-foreground text-xs">{c.phone}</span>}
                </button>
              ))}
              {results.length === 0 && query && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No customers found</div>
              )}
              <div className="border-t px-3 py-2">
                {creating ? (
                  <div className="flex gap-2">
                    <Input
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && createCustomer()}
                      placeholder="Customer name"
                      className="h-8 text-sm"
                      autoFocus
                    />
                    <Button size="sm" className="h-8" onClick={createCustomer} disabled={!newName.trim() || submitting}>
                      Create
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setCreating(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <button
                    className="text-sm text-primary hover:underline"
                    onClick={() => setCreating(true)}
                  >
                    + New customer
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
