import { formatGBP } from '@/lib/pricing'

export interface LabelData {
  dataUrl: string
  cardName: string
  condition: string
  quantity: number // copies to print — one label per physical card
  sellPrice: number | null // pence
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Opens a print window with one 62mm label per physical copy (same layout as
// the single QRLabel). Returns false when the pop-up was blocked so callers
// can toast.
export function printLabelSheet(labels: LabelData[]): boolean {
  const win = window.open('', '_blank')
  if (!win) return false
  const cells = labels.flatMap(l => Array.from({ length: Math.max(1, l.quantity) }, () => `
    <div class="label">
      <img src="${l.dataUrl}"/>
      <div class="name">${esc(l.cardName)}</div>
      <div class="cond">${esc(l.condition)}</div>
      <div class="price">${esc(formatGBP(l.sellPrice))}</div>
    </div>`)).join('\n')
  win.document.write(`<!DOCTYPE html><html><head><title>QR Labels</title>
    <style>
      body{margin:8mm;font-family:sans-serif;display:flex;flex-wrap:wrap;gap:4mm}
      .label{width:62mm;padding:4mm;text-align:center;border:1px dashed #ccc;border-radius:4px;break-inside:avoid}
      img{width:40mm}
      .name{font-size:10pt;font-weight:700;margin-top:3mm}
      .cond{font-size:9pt;color:#555}
      .price{font-size:14pt;font-weight:700;margin-top:2mm}
    </style></head><body>${cells}</body></html>`)
  win.document.close()
  win.focus()
  win.print()
  return true
}
