'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatGBP } from '@/lib/pricing'
import type { Customer, CreditLedger, WantListItem } from '@/lib/db/schema'

interface CustomerData {
  customer: Customer
  balance: number
  ledger: CreditLedger[]
  wants: WantListItem[]
}

interface Props {
  id: number
}

export function CustomerDetail({ id }: Props) {
  const [data, setData] = useState<CustomerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Edit fields
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Adjust credit
  const [creditDelta, setCreditDelta] = useState('')
  const [adjusting, setAdjusting] = useState(false)

  useEffect(() => {
    fetch(`/api/customers/${id}`)
      .then(async res => {
        if (res.status === 404) { setNotFound(true); return }
        if (!res.ok) throw new Error()
        const d: CustomerData = await res.json()
        setData(d)
        setEditName(d.customer.name)
        setEditPhone(d.customer.phone ?? '')
        setEditEmail(d.customer.email ?? '')
        setEditNotes(d.customer.notes ?? '')
      })
      .catch(() => toast.error('Could not load customer'))
      .finally(() => setLoading(false))
  }, [id])

  async function saveEdit() {
    if (!data) return
    setSaving(true)
    try {
      const res = await fetch(`/api/customers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, phone: editPhone || null, email: editEmail || null, notes: editNotes || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not save')
        return
      }
      const updated: Customer = await res.json()
      setData(prev => prev ? { ...prev, customer: updated } : prev)
      setEditing(false)
      toast.success('Saved')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  async function adjustCredit() {
    const n = parseFloat(creditDelta)
    if (!Number.isFinite(n) || n === 0) { toast.error('Enter a non-zero amount'); return }
    setAdjusting(true)
    try {
      const res = await fetch(`/api/customers/${id}/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: n }),
      })
      if (res.status === 403) { toast.error('Admin access required'); return }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not adjust credit')
        return
      }
      const { balance }: { balance: number } = await res.json()
      // Refresh full data to get updated ledger
      const refresh = await fetch(`/api/customers/${id}`)
      if (refresh.ok) {
        const d: CustomerData = await refresh.json()
        setData(d)
      } else {
        setData(prev => prev ? { ...prev, balance } : prev)
      }
      setCreditDelta('')
      toast.success(`Balance updated to ${formatGBP(balance)}`)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setAdjusting(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading…</div>
  if (notFound) return (
    <div className="p-8 text-center space-y-3">
      <p className="text-muted-foreground">Customer not found.</p>
      <Link href="/customers"><Button variant="outline">← Customers</Button></Link>
    </div>
  )
  if (!data) return null

  const { customer, balance, ledger, wants } = data

  return (
    <div className="max-w-2xl space-y-5">
      {/* Back link */}
      <Link href="/customers" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
        ← Customers
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{customer.name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {customer.phone ?? ''}{customer.phone && customer.email ? ' · ' : ''}{customer.email ?? ''}
            {!customer.phone && !customer.email && 'No contact info'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(v => !v)}>
          {editing ? 'Cancel' : 'Edit'}
        </Button>
      </div>

      {/* Edit form */}
      {editing && (
        <section className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Edit Customer</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Name *</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} type="tel" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={editEmail} onChange={e => setEditEmail(e.target.value)} type="email" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Notes</Label>
              <Input value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Internal notes…" />
            </div>
          </div>
          <Button className="w-full" onClick={saveEdit} disabled={saving || !editName.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </section>
      )}

      {/* Store credit balance */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Store Credit</h2>
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold text-primary">{formatGBP(balance)}</span>
          <span className="text-sm text-muted-foreground">current balance</span>
        </div>

        {/* Adjust credit (admin) */}
        <div className="border-t border-border pt-4 space-y-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Adjust credit (admin)</p>
          <div className="flex gap-2">
            <Input
              type="number"
              step="0.01"
              placeholder="e.g. 5.00 or -2.50"
              value={creditDelta}
              onChange={e => setCreditDelta(e.target.value)}
              className="h-9 w-40"
            />
            <Button size="sm" className="h-9" onClick={adjustCredit} disabled={adjusting || !creditDelta}>
              {adjusting ? 'Applying…' : 'Apply'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Positive = add credit, negative = deduct credit.</p>
        </div>
      </section>

      {/* Ledger */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Credit History</h2>
        {ledger.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credit transactions yet.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  {['Date', 'Reason', 'Amount'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ledger.map(row => (
                  <tr key={row.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-3 py-2 capitalize">{row.reason}</td>
                    <td className={`px-3 py-2 font-semibold ${row.delta >= 0 ? 'text-emerald-400' : 'text-destructive'}`}>
                      {row.delta >= 0 ? '+' : ''}{formatGBP(row.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Want list */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Want List</h2>
        {wants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items on the want list.</p>
        ) : (
          <ul className="space-y-1.5">
            {wants.map(w => (
              <li key={w.id} className="flex items-center gap-2 text-sm">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${w.fulfilledAt ? 'bg-emerald-400' : 'bg-muted-foreground'}`} />
                <span className={w.fulfilledAt ? 'text-muted-foreground line-through' : ''}>
                  {w.freeText ?? `Card #${w.cardId}`}
                </span>
                {w.fulfilledAt && (
                  <span className="text-xs text-muted-foreground">
                    (fulfilled {new Date(w.fulfilledAt).toLocaleDateString('en-GB')})
                  </span>
                )}
                {w.notify && !w.fulfilledAt && (
                  <span className="text-xs border border-primary/30 text-primary px-1.5 py-0.5 rounded ml-auto">notify</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
