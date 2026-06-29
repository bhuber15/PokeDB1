'use client'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { calculateSellPrice, formatGBP } from '@/lib/pricing'
import type { Card, InventoryItem, PriceCache } from '@/lib/db/schema'

export interface InventoryRow {
  item: InventoryItem
  card: Card | null
  prices: PriceCache | null
}

interface InventoryTableProps {
  rows: InventoryRow[]
  onStockChange: (id: number, quantity: number) => void
  onPrintQR: (id: number) => void
}

export function InventoryTable({ rows, onStockChange, onPrintQR }: InventoryTableProps) {
  const [editing, setEditing] = useState<Record<number, string>>({})

  function handleBlur(id: number, current: number) {
    const val = parseInt(editing[id] ?? '')
    if (!isNaN(val) && val >= 0 && val !== current) onStockChange(id, val)
    setEditing(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/50">
          <tr>
            {['Card', 'Condition', 'Stock', 'Cost', 'Sell', 'TCG Market', 'Location', ''].map(h => (
              <th key={h} className="text-left p-3 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, card, prices }) => {
            const sellPrice = calculateSellPrice(prices?.tcgplayerMarket, item.sellPriceOverride)
            const isLow = item.quantity <= item.lowStockThreshold
            return (
              <tr key={item.id} className="border-b last:border-0 hover:bg-muted/20">
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    {card?.imageUrl && (
                      <img src={card.imageUrl} alt={card.name} className="w-8 h-10 object-contain flex-shrink-0" />
                    )}
                    <div>
                      <div className="font-medium">{card?.name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{card?.setName} · #{card?.setNumber}</div>
                      {item.defectNotes && <div className="text-xs text-orange-600 mt-0.5">{item.defectNotes}</div>}
                    </div>
                  </div>
                </td>
                <td className="p-3"><Badge variant="outline">{item.condition}</Badge></td>
                <td className="p-3">
                  <Input
                    className={`w-16 h-7 text-center text-sm ${isLow ? 'border-destructive text-destructive' : ''}`}
                    value={item.id in editing ? editing[item.id] : item.quantity}
                    onChange={e => setEditing(prev => ({ ...prev, [item.id]: e.target.value }))}
                    onBlur={() => handleBlur(item.id, item.quantity)}
                    type="number"
                    min={0}
                  />
                </td>
                <td className="p-3 text-muted-foreground">{formatGBP(item.costPrice)}</td>
                <td className="p-3 font-medium">{formatGBP(sellPrice)}</td>
                <td className="p-3">
                  {prices?.isHighValue && <Badge variant="destructive" className="mr-1 text-xs">⚠</Badge>}
                  <span className={prices?.isHighValue ? 'text-destructive font-medium' : ''}>
                    {formatGBP(prices?.tcgplayerMarket)}
                  </span>
                </td>
                <td className="p-3 text-xs text-muted-foreground">{item.location ?? '—'}</td>
                <td className="p-3">
                  <Button variant="ghost" size="sm" onClick={() => onPrintQR(item.id)}>QR</Button>
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No inventory items yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
