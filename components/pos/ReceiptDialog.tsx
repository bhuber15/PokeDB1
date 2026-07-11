'use client'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { formatGBP } from '@/lib/pricing'

export interface ReceiptData {
  saleId: number
  at: string // ISO
  shopName: string
  lines: { name: string; condition: string; quantity: number; price: number }[]
  subtotal: number
  discount: number
  vatAmount: number
  vatScheme: 'none' | 'standard' | 'margin'
  total: number
  paymentMethod: string
  cashReceived?: number
  changeDue?: number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function receiptHtml(r: ReceiptData): string {
  const when = new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const row = (label: string, value: string, bold = false) =>
    `<tr${bold ? ' class="b"' : ''}><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`
  return `<!DOCTYPE html><html><head><title>Receipt #${r.saleId}</title>
<style>
  body { font: 12px/1.5 ui-monospace, Menlo, monospace; color: #000; width: 260px; margin: 12px auto; }
  h1 { font-size: 14px; text-align: center; margin: 0 0 2px; }
  p { text-align: center; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .b td { font-weight: 700; font-size: 13px; padding-top: 4px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; }
</style></head><body>
<h1>${esc(r.shopName)}</h1>
<p>Sale #${r.saleId} · ${esc(when)}</p>
<table>
${r.lines.map(l => row(`${l.quantity}× ${l.name} (${l.condition})`, formatGBP(l.price * l.quantity))).join('\n')}
</table>
<hr/>
<table>
${row('Subtotal', formatGBP(r.subtotal))}
${r.discount > 0 ? row('Discount', `-${formatGBP(r.discount)}`) : ''}
${r.vatScheme === 'standard' && r.vatAmount > 0 ? row('VAT (20%)', formatGBP(r.vatAmount)) : ''}
${row('Total', formatGBP(r.total), true)}
${row('Paid', r.paymentMethod.replace('_', ' '))}
${r.cashReceived != null ? row('Cash', formatGBP(r.cashReceived)) : ''}
${r.changeDue != null && r.changeDue > 0 ? row('Change', formatGBP(r.changeDue)) : ''}
</table>
${r.vatScheme === 'margin' ? '<p style="margin:6px 0 0;font-size:11px;">Sold under the VAT Margin Scheme</p>' : ''}
<hr/>
<p>Thank you!</p>
</body></html>`
}

export function ReceiptDialog({ receipt, onClose }: { receipt: ReceiptData | null; onClose: () => void }) {
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
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={print} className="flex-1">Print receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
