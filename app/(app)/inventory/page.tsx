'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { InventoryTable, InventoryRow } from '@/components/inventory/InventoryTable'
import { QRLabel } from '@/components/inventory/QRLabel'
import { calculateSellPrice, formatGBP } from '@/lib/pricing'

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [qrModal, setQrModal] = useState<{
    dataUrl: string; cardName: string; condition: string; sellPrice: string
  } | null>(null)

  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(setRows)
  }, [])

  async function handleStockChange(id: number, quantity: number) {
    await fetch(`/api/inventory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    })
    setRows(prev => prev.map(r => r.item.id === id ? { ...r, item: { ...r.item, quantity } } : r))
  }

  async function handlePrintQR(id: number) {
    const row = rows.find(r => r.item.id === id)!
    const { dataUrl } = await fetch(`/api/inventory/${id}/qr`).then(r => r.json())
    setQrModal({
      dataUrl,
      cardName: row.card?.name ?? 'Unknown',
      condition: row.item.condition,
      sellPrice: formatGBP(calculateSellPrice(row.prices?.tcgplayerMarket, row.item.sellPriceOverride)),
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Inventory</h1>
        <Link href="/inventory/add" className={buttonVariants()}>+ Add Item</Link>
      </div>
      <InventoryTable rows={rows} onStockChange={handleStockChange} onPrintQR={handlePrintQR} />
      <Dialog open={!!qrModal} onOpenChange={() => setQrModal(null)}>
        <DialogContent className="max-w-xs">
          <DialogTitle>QR Label</DialogTitle>
          {qrModal && <QRLabel {...qrModal} onClose={() => setQrModal(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
