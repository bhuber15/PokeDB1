'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { formatGBP } from '@/lib/pricing'
import { receiptHtml, type ReceiptData } from '@/lib/receipt-html'

// Re-export so existing imports (pos/page.tsx) keep working.
export type { ReceiptData }

export function ReceiptDialog({ receipt, onClose }: { receipt: ReceiptData | null; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)

  async function sendByEmail() {
    if (!receipt || sending) return
    setSending(true)
    try {
      const res = await fetch(`/api/sales/${receipt.saleId}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Blank input → server falls back to the sale's customer email
        body: JSON.stringify(email.trim() ? { email: email.trim() } : {}),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) {
        toast.success(`Receipt emailed to ${data.to}`)
        setEmail('')
      } else if (res.ok && data?.skipped) {
        toast.info('Email sending is not configured (RESEND_API_KEY) — receipt not sent')
      } else {
        toast.error(data?.error ?? 'Failed to send receipt')
      }
    } catch {
      toast.error('Network error — receipt not sent')
    } finally {
      setSending(false)
    }
  }

  function print() {
    if (!receipt) return
    const win = window.open('', '_blank')
    if (!win) {
      toast.error('Allow pop-ups for this site to print receipts')
      return
    }
    win.document.write(receiptHtml(receipt))
    win.document.close()
    win.print()
  }

  return (
    <Dialog open={!!receipt} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Receipt — sale #{receipt?.saleId}</DialogTitle>
        {receipt && (
          <div className="space-y-3 text-sm">
            <div className="border rounded-lg divide-y max-h-56 overflow-y-auto">
              {receipt.lines.map((l, i) => (
                <div key={i} className="flex justify-between p-2">
                  <span className="text-muted-foreground">{l.quantity}× {l.name} ({l.condition})</span>
                  <span className="font-medium">{formatGBP(l.price * l.quantity)}</span>
                </div>
              ))}
            </div>
            <Separator />
            <div className="space-y-1">
              <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{formatGBP(receipt.subtotal)}</span></div>
              {receipt.discount > 0 && <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>-{formatGBP(receipt.discount)}</span></div>}
              {receipt.vatScheme === 'standard' && receipt.vatAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>VAT (20%)</span><span>{formatGBP(receipt.vatAmount)}</span></div>}
              <div className="flex justify-between font-bold text-base"><span>Total ({receipt.paymentMethod.replace('_', ' ')})</span><span>{formatGBP(receipt.total)}</span></div>
              {receipt.vatScheme === 'margin' && <div className="text-xs text-muted-foreground pt-1">Sold under the VAT Margin Scheme</div>}
              {receipt.changeDue != null && receipt.changeDue > 0 && (
                <div className="flex justify-between font-semibold text-emerald-400"><span>Change given</span><span>{formatGBP(receipt.changeDue)}</span></div>
              )}
            </div>
          </div>
        )}
        {receipt && (
          <div className="flex gap-2">
            <Input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email (blank = customer's)"
              aria-label="Email receipt to"
            />
            <Button variant="outline" onClick={sendByEmail} disabled={sending}>
              {sending ? 'Sending…' : 'Email'}
            </Button>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={print} className="flex-1">Print receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
