'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatGBP } from '@/lib/pricing'
import { toast } from 'sonner'

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
  const [items, setItems] = useState<LineItem[]>([])
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [method, setMethod] = useState<'cash' | 'store_credit'>('cash')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !saleId) return
    fetch(`/api/sales/${saleId}/items`).then(r => r.json()).then(data => {
      setItems(data.items ?? [])
      setSelected({})
    })
  }, [open, saleId])

  function setQty(saleItemId: number, qty: number, max: number) {
    setSelected(prev => ({ ...prev, [saleItemId]: Math.max(0, Math.min(qty, max)) }))
  }

  const linesToRefund = Object.entries(selected).filter(([, qty]) => qty > 0)

  async function submit() {
    if (!saleId || linesToRefund.length === 0 || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleId, method,
          items: linesToRefund.map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity })),
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
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={submit} disabled={loading || linesToRefund.length === 0} className="flex-1">
            {loading ? 'Processing…' : 'Refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
