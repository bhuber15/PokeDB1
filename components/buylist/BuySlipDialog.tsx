'use client'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { formatGBP } from '@/lib/pricing'
import { printLabelSheet, type LabelData } from '@/components/shared/printLabelSheet'
import { useSettings } from '@/components/shared/SettingsProvider'
import { PRODUCT_CONDITION } from '@/lib/product-categories'

export interface BuySlipData {
  buyId: number
  at: string // ISO
  method: 'cash' | 'store_credit'
  total: number
  customerId: number | null
  customerName: string | null
  lines: { cardName: string; condition: string; quantity: number; payPrice: number; productId?: number }[]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// PRODUCT_CONDITION is the sentinel stored for product lines (no condition
// ladder) — printed and displayed plain, without a trailing "(NA)".
const lineLabel = (l: BuySlipData['lines'][number]) =>
  l.condition !== PRODUCT_CONDITION ? `${l.quantity}× ${l.cardName} (${l.condition})` : `${l.quantity}× ${l.cardName}`

// Same 260px monospace print pattern as the POS ReceiptDialog.
function slipHtml(s: BuySlipData, shopName: string): string {
  const when = new Date(s.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const row = (label: string, value: string, bold = false) =>
    `<tr${bold ? ' class="b"' : ''}><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`
  return `<!DOCTYPE html><html><head><title>Buy slip #${s.buyId}</title>
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
<h1>${esc(shopName)} — WE BOUGHT</h1>
<p>Buy #${s.buyId} · ${esc(when)}${s.customerName ? `<br/>From: ${esc(s.customerName)}` : ''}</p>
<table>
${s.lines.map(l => row(lineLabel(l), formatGBP(l.payPrice * l.quantity))).join('\n')}
</table>
<hr/>
<table>
${row(`Paid (${s.method === 'cash' ? 'cash' : 'store credit'})`, formatGBP(s.total), true)}
</table>
<hr/>
<p>Seller signature: ______________________</p>
</body></html>`
}

export function BuySlipDialog({ slip, onClose }: { slip: BuySlipData | null; onClose: () => void }) {
  const { shopName } = useSettings()
  const [labelsLoading, setLabelsLoading] = useState(false)

  function printSlip() {
    if (!slip) return
    const win = window.open('', '_blank')
    if (!win) {
      toast.error('Allow pop-ups for this site to print buy slips')
      return
    }
    win.document.write(slipHtml(slip, shopName))
    win.document.close()
    win.print()
  }

  // Labels come from the server so intake merges and price rules are honoured.
  async function printLabels() {
    if (!slip) return
    setLabelsLoading(true)
    try {
      const detail = await fetch(`/api/buys/${slip.buyId}`).then(r => (r.ok ? r.json() : null))
      const items = (detail?.items ?? []) as { inventoryItemId: number | null; quantity: number }[]
      // /api/labels/batch is card-shaped (QR + card name, no product join) —
      // buy items come back in the same order the slip's lines were
      // submitted, so use the slip's productId to skip product lines rather
      // than guessing off the 'NA' condition sentinel.
      const cardItems = items.filter((_, i) => slip.lines[i]?.productId == null)
      const ids: number[] = [...new Set(
        cardItems.map(i => i.inventoryItemId).filter((id): id is number => id != null),
      )]
      if (ids.length === 0) {
        toast.error('No inventory items found for this buy')
        return
      }
      const res = await fetch('/api/labels/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryItemIds: ids }),
      })
      if (!res.ok) {
        toast.error('Could not build labels')
        return
      }
      const { labels } = await res.json() as { labels: (LabelData & { inventoryItemId: number })[] }
      // Print one label per copy bought in THIS buy, not per total stock
      const boughtQty = new Map<number, number>()
      for (const it of cardItems) {
        if (it.inventoryItemId != null) {
          boughtQty.set(it.inventoryItemId, (boughtQty.get(it.inventoryItemId) ?? 0) + it.quantity)
        }
      }
      const adjusted = labels.map(l => ({ ...l, quantity: boughtQty.get(l.inventoryItemId) ?? l.quantity }))
      if (!printLabelSheet(adjusted)) toast.error('Allow pop-ups for this site to print labels')
    } finally {
      setLabelsLoading(false)
    }
  }

  return (
    <Dialog open={!!slip} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Buy complete — #{slip?.buyId}</DialogTitle>
        {slip && (
          <div className="space-y-3 text-sm">
            <div className="border rounded-lg divide-y max-h-56 overflow-y-auto">
              {slip.lines.map((l, i) => (
                <div key={i} className="flex justify-between p-2">
                  <span className="text-muted-foreground">{lineLabel(l)}</span>
                  <span className="font-medium">{formatGBP(l.payPrice * l.quantity)}</span>
                </div>
              ))}
            </div>
            <Separator />
            <div className="flex justify-between font-bold text-base">
              <span>Paid ({slip.method === 'cash' ? 'cash' : 'store credit'})</span>
              <span>{formatGBP(slip.total)}</span>
            </div>
            {slip.customerName && <div className="text-muted-foreground">From {slip.customerName}</div>}
            {/* Trade-in handoff: the credit just posted is spendable right away,
                so offer the natural next step — ring up their purchase. */}
            {slip.method === 'store_credit' && slip.customerId != null && (
              <Link
                href={`/pos?customerId=${slip.customerId}`}
                className={buttonVariants({ className: 'w-full' })}
              >
                Sell to {slip.customerName ?? 'customer'} — {formatGBP(slip.total)} credit →
              </Link>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button variant="outline" onClick={printLabels} disabled={labelsLoading}>
            {labelsLoading ? 'Building…' : 'Print QR labels'}
          </Button>
          <Button onClick={printSlip} className="flex-1">Print buy slip</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
