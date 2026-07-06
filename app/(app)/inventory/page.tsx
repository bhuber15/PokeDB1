'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { InventoryTable, InventoryRow } from '@/components/inventory/InventoryTable'
import { QRLabel } from '@/components/inventory/QRLabel'
import { ImportDialog } from '@/components/inventory/ImportDialog'
import { calculateSellPrice, formatGBP } from '@/lib/pricing'
import type { AdjustmentReason } from '@/lib/adjustment-reasons'

export default function InventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [qrModal, setQrModal] = useState<{
    dataUrl: string; cardName: string; condition: string; sellPrice: string
  } | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  function refetch() {
    fetch('/api/inventory').then(r => r.json()).then(setRows).finally(() => setLoading(false))
  }

  useEffect(() => {
    refetch()
  }, [])

  async function handleStockChange(id: number, quantity: number, reason: AdjustmentReason) {
    await fetch(`/api/inventory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity, reason }),
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
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API-route file download, not a page navigation */}
          <a href="/api/inventory/export"><Button variant="outline">Export CSV</Button></a>
          <Button variant="outline" onClick={() => setImportOpen(true)}>Import CSV</Button>
          <Link href="/inventory/add" className={buttonVariants()}>+ Add Item</Link>
        </div>
      </div>
      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading inventory">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-12 text-center space-y-3">
          <p className="text-lg font-semibold">No stock yet</p>
          <p className="text-sm text-muted-foreground">
            Add a card from the catalogue, buy from a customer via the buylist, or import a CSV.
          </p>
          <Link href="/inventory/add" className={buttonVariants()}>+ Add your first card</Link>
        </div>
      ) : (
        <InventoryTable rows={rows} onStockChange={handleStockChange} onPrintQR={handlePrintQR} />
      )}
      <Dialog open={!!qrModal} onOpenChange={() => setQrModal(null)}>
        <DialogContent className="max-w-xs">
          <DialogTitle>QR Label</DialogTitle>
          {qrModal && <QRLabel {...qrModal} onClose={() => setQrModal(null)} />}
        </DialogContent>
      </Dialog>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={refetch}
      />
    </div>
  )
}
