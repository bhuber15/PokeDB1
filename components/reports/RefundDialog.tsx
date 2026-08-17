'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CustomerPicker } from '@/components/shared/CustomerPicker'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'
import { formatGBP } from '@/lib/pricing'
import { toast } from 'sonner'
import type { Customer } from '@/lib/db/schema'

interface LineItem {
  saleItemId: number
  name: string
  condition: string | null
  quantity: number
  priceAtSale: number
  refundedQuantity: number
}

interface Props {
  saleId: number | null
  open: boolean
  onClose: () => void
  onDone: () => void
}

export function RefundDialog({ saleId, open, onClose, onDone }: Props) {
  const online = useOnlineStatus()
  const [items, setItems] = useState<LineItem[]>([])
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [method, setMethod] = useState<'cash' | 'store_credit'>('cash')
  // Who receives a store-credit refund: preselected from the sale's customer,
  // pickable for walk-in sales.
  const [creditCustomer, setCreditCustomer] = useState<Customer | null>(null)
  // The sale's own customer — when the picker still holds them, customerId is
  // omitted from the request so createRefund's default stays the one source
  // of truth; it is sent only as a staff override.
  const [saleCustomerId, setSaleCustomerId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  // Per-sale state carryover (tender method, items, recipient) is prevented
  // by the parent keying this dialog by saleId — every open is a fresh mount
  // with initial state, so no resets are needed here.
  useEffect(() => {
    if (!open || !saleId) return
    let stale = false
    fetch(`/api/sales/${saleId}/items`)
      .then(r => r.json())
      .then(data => {
        if (stale) return
        setItems(data.items ?? [])
        setCreditCustomer(data.customer ?? null)
        setSaleCustomerId(data.customer?.id ?? null)
      })
      .catch(() => { if (!stale) toast.error('Failed to load sale items — reopen to retry') })
    return () => { stale = true }
  }, [open, saleId])

  function setQty(saleItemId: number, qty: number, max: number) {
    setSelected(prev => ({ ...prev, [saleItemId]: Math.max(0, Math.min(qty, max)) }))
  }

  const linesToRefund = Object.entries(selected).filter(([, qty]) => qty > 0)
  const missingCreditCustomer = method === 'store_credit' && !creditCustomer

  async function submit() {
    if (!saleId || linesToRefund.length === 0 || missingCreditCustomer || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleId, method,
          items: linesToRefund.map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity })),
          ...(method === 'store_credit' && creditCustomer && creditCustomer.id !== saleCustomerId
            ? { customerId: creditCustomer.id }
            : {}),
        }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}))
        toast.error(error ?? 'Refund failed')
        return
      }
      const { amount } = await res.json()
      toast.success(`Refunded ${formatGBP(amount)}`)
      onDone()
      onClose()
    } catch {
      toast.error('Refund failed — check your connection')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Refund Sale #{saleId}</DialogTitle>
        <div className="space-y-3">
          <div className="border rounded-lg divide-y text-sm max-h-56 overflow-y-auto">
            {items.map(item => {
              const max = item.quantity - item.refundedQuantity
              return (
                <div key={item.saleItemId} className="flex items-center justify-between p-2 gap-2">
                  <div className="min-w-0">
                    <div className="truncate">{item.name} {item.condition ? `(${item.condition})` : ''}</div>
                    <div className="text-xs text-muted-foreground">{formatGBP(item.priceAtSale)} each · {max} left</div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={max}
                    disabled={max === 0}
                    value={selected[item.saleItemId] ?? 0}
                    onChange={e => setQty(item.saleItemId, parseInt(e.target.value) || 0, max)}
                    className="border rounded px-2 py-1 w-16 text-right text-sm disabled:opacity-40"
                  />
                </div>
              )
            })}
            {items.length === 0 && <p className="p-3 text-muted-foreground">Loading…</p>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={method === 'cash' ? 'default' : 'outline'} onClick={() => setMethod('cash')}>Cash</Button>
            <Button size="sm" variant={method === 'store_credit' ? 'default' : 'outline'} onClick={() => setMethod('store_credit')}>Store Credit</Button>
          </div>
          {method === 'store_credit' && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Credit goes to</p>
              <CustomerPicker selected={creditCustomer} onSelect={setCreditCustomer} />
            </div>
          )}
        </div>
        {!online && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Offline — refunds need a connection.</p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={submit} disabled={loading || linesToRefund.length === 0 || missingCreditCustomer || !online} className="flex-1">
            {loading ? 'Processing…' : 'Refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
