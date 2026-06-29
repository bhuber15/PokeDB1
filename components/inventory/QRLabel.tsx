'use client'
import { Button } from '@/components/ui/button'

interface QRLabelProps {
  dataUrl: string
  cardName: string
  condition: string
  sellPrice: string
  onClose: () => void
}

export function QRLabel({ dataUrl, cardName, condition, sellPrice, onClose }: QRLabelProps) {
  function print() {
    const win = window.open('', '_blank')!
    win.document.write(`<!DOCTYPE html><html><head><title>Label</title>
      <style>
        body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
        .label{width:62mm;padding:4mm;font-family:sans-serif;text-align:center;border:1px solid #ccc;border-radius:4px}
        img{width:40mm}
        .name{font-size:10pt;font-weight:700;margin-top:3mm}
        .cond{font-size:9pt;color:#555}
        .price{font-size:14pt;font-weight:700;margin-top:2mm}
      </style></head><body>
      <div class="label">
        <img src="${dataUrl}"/>
        <div class="name">${cardName}</div>
        <div class="cond">${condition}</div>
        <div class="price">${sellPrice}</div>
      </div></body></html>`)
    win.document.close()
    win.focus()
    win.print()
  }

  return (
    <div className="flex flex-col items-center gap-4 p-2">
      <img src={dataUrl} alt="QR Code" className="w-40 h-40" />
      <div className="text-center">
        <div className="font-semibold">{cardName}</div>
        <div className="text-sm text-muted-foreground">{condition} · {sellPrice}</div>
      </div>
      <div className="flex gap-2 w-full">
        <Button className="flex-1" onClick={print}>Print Label</Button>
        <Button variant="outline" className="flex-1" onClick={onClose}>Close</Button>
      </div>
    </div>
  )
}
