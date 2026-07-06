'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { WantsPanel } from '@/components/customers/WantsPanel'
import { toast } from 'sonner'
import type { Customer } from '@/lib/db/schema'

type View = 'customers' | 'wants'

export default function CustomersPage() {
  const router = useRouter()
  const [view, setView] = useState<View>('customers')
  const [query, setQuery] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newEmail, setNewEmail] = useState('')

  // Arriving via a link like /customers?view=wants (e.g. the old /wants redirect).
  // Timer defers the update past the effect's sync phase (set-state-in-effect).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') !== 'wants') return
    const t = setTimeout(() => setView('wants'), 0)
    return () => clearTimeout(t)
  }, [])

  function selectView(v: View) {
    setView(v)
    router.replace(v === 'wants' ? '/customers?view=wants' : '/customers')
  }

  const fetchCustomers = useCallback(async (q: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`)
      if (!res.ok) throw new Error()
      setCustomers(await res.json())
    } catch {
      toast.error('Could not load customers')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load of recents (t=0), then debounced search
  useEffect(() => {
    const t = setTimeout(() => fetchCustomers(query), query ? 300 : 0)
    return () => clearTimeout(t)
  }, [query, fetchCustomers])

  async function createCustomer() {
    if (!newName.trim()) { toast.error('Name is required'); return }
    setCreating(true)
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), phone: newPhone || undefined, email: newEmail || undefined }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not create customer')
        return
      }
      const c: Customer = await res.json()
      toast.success(`Created ${c.name}`)
      setShowNew(false)
      setNewName(''); setNewPhone(''); setNewEmail('')
      // Refresh list
      fetchCustomers(query)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Customers</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {view === 'wants' ? 'Outstanding wants across every customer' : 'Search or browse recent customers'}
          </p>
        </div>
        {view === 'customers' && (
          <Button onClick={() => setShowNew(v => !v)}>
            {showNew ? 'Cancel' : '+ New customer'}
          </Button>
        )}
      </div>

      {/* View toggle */}
      <div className="flex gap-2">
        <Button size="sm" variant={view === 'customers' ? 'default' : 'outline'} onClick={() => selectView('customers')}>
          Customers
        </Button>
        <Button size="sm" variant={view === 'wants' ? 'default' : 'outline'} onClick={() => selectView('wants')}>
          Want List
        </Button>
      </div>

      {view === 'wants' ? (
        <WantsPanel />
      ) : (
        <>
          {/* New customer form */}
          {showNew && (
            <section className="bg-card border border-border rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">New Customer</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Name *</Label>
                  <Input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Full name"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Phone</Label>
                  <Input
                    value={newPhone}
                    onChange={e => setNewPhone(e.target.value)}
                    placeholder="07700 900000"
                    type="tel"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    placeholder="name@example.com"
                    type="email"
                  />
                </div>
              </div>
              <Button className="w-full" onClick={createCustomer} disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create customer'}
              </Button>
            </section>
          )}

          {/* Search */}
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="h-10"
          />

          {/* Customer list */}
          <div className="rounded-xl border border-border overflow-hidden">
            {loading ? (
              <div className="p-3 space-y-2" role="status" aria-label="Loading customers">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : customers.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm space-y-1">
                <p className="font-medium text-foreground">{query ? `No customers found for "${query}"` : 'No customers yet'}</p>
                {!query && <p>Add one with “+ New Customer”, or they’re created automatically when store credit is used at the till.</p>}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/30">
                  <tr>
                    {['Name', 'Phone', ''].map(h => (
                      <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.map(c => (
                    <tr key={c.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                      <td className="px-4 py-3 font-medium">{c.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.phone ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/customers/${c.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs">View →</Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
