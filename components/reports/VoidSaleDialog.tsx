'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'

interface Props {
  saleId: number | null
  open: boolean
  onClose: () => void
  onDone: () => void
}

// Same-day full reversal for a staff mis-ring. Distinct from a refund:
// restores all stock, returns store credit, and marks the sale voided so it
// drops out of every report. The server enforces the same-day window and
// rejects sales that already have refunds.
export function VoidSaleDialog({ saleId, open, onClose, onDone }: Props) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!saleId || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/sales/${saleId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}))
        toast.error(error ?? 'Void failed')
        return
      }
      toast.success('Sale voided — stock restored')
      setReason('')
      onDone()
      onClose()
    } catch {
      toast.error('Network error — sale not voided')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent>
        <DialogTitle>Void sale #{saleId}</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Fully reverses this sale: stock goes back, store credit is returned, and it
          disappears from reports. Only for same-day mis-rings — use Refund for customer returns.
        </p>
        <div className="space-y-1">
          <Label htmlFor="void-reason">Reason</Label>
          <Input
            id="void-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. wrong card scanned"
            maxLength={500}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={loading}>
            {loading ? 'Voiding…' : 'Void sale'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
