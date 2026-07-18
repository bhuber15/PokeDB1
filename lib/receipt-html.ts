// Dependency-free receipt model + HTML renderer, shared by the POS receipt
// dialog (print) and the email-receipt domain path (server render). Must not
// import anything that touches lib/db — client components value-import this.

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
  // Split tender: one line per method. Single-method sales may omit this.
  payments?: { method: string; amount: number }[]
  cashReceived?: number
  changeDue?: number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function receiptHtml(r: ReceiptData): string {
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
${r.payments && r.payments.length > 1
    ? r.payments.map(p => row(`Paid — ${p.method.replace('_', ' ')}`, formatGBP(p.amount))).join('\n')
    : row('Paid', r.paymentMethod.replace('_', ' '))}
${r.cashReceived != null ? row('Cash', formatGBP(r.cashReceived)) : ''}
${r.changeDue != null && r.changeDue > 0 ? row('Change', formatGBP(r.changeDue)) : ''}
</table>
${r.vatScheme === 'margin' ? '<p style="margin:6px 0 0;font-size:11px;">Sold under the VAT Margin Scheme</p>' : ''}
<hr/>
<p>Thank you!</p>
</body></html>`
}

// Plain-text fallback for email clients that skip HTML.
export function receiptText(r: ReceiptData): string {
  const lines = [
    `${r.shopName} — Receipt #${r.saleId}`,
    ...r.lines.map(l => `${l.quantity}x ${l.name} (${l.condition})  ${formatGBP(l.price * l.quantity)}`),
    `Subtotal ${formatGBP(r.subtotal)}`,
    ...(r.discount > 0 ? [`Discount -${formatGBP(r.discount)}`] : []),
    ...(r.vatScheme === 'standard' && r.vatAmount > 0 ? [`VAT (20%) ${formatGBP(r.vatAmount)}`] : []),
    `Total ${formatGBP(r.total)}`,
    ...(r.payments && r.payments.length > 1
      ? r.payments.map(p => `Paid ${p.method.replace('_', ' ')} ${formatGBP(p.amount)}`)
      : [`Paid ${r.paymentMethod.replace('_', ' ')}`]),
    ...(r.vatScheme === 'margin' ? ['Sold under the VAT Margin Scheme'] : []),
    'Thank you!',
  ]
  return lines.join('\n')
}
