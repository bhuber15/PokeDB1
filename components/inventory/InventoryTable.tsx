'use client'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { calculateSellPrice, formatGBP } from '@/lib/pricing'
import { CardZoomModal, type CardZoomData } from '@/components/shared/CardZoomModal'
import { useSettings } from '@/components/shared/SettingsProvider'
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

const CONDITION_BADGE: Record<string, string> = {
  NM: 'border-emerald-500/40 text-emerald-400',
  LP: 'border-blue-500/40 text-blue-400',
  MP: 'border-yellow-500/40 text-yellow-400',
  HP: 'border-orange-500/40 text-orange-400',
  DMG: 'border-red-500/40 text-red-400',
}

export function InventoryTable({ rows, onStockChange, onPrintQR }: InventoryTableProps) {
  const [editing, setEditing] = useState<Record<number, string>>({})
  const [zoomCard, setZoomCard] = useState<CardZoomData | null>(null)
  const { marginMultiplier } = useSettings()

  function handleBlur(id: number, current: number) {
    const val = parseInt(editing[id] ?? '')
    if (!isNaN(val) && val >= 0 && val !== current) onStockChange(id, val)
    setEditing(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  return (
    <>
      <CardZoomModal card={zoomCard} onClose={() => setZoomCard(null)} />
      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30">
            <tr>
              {['Card', 'Condition', 'Stock', 'Cost', 'Sell Price', 'TCG Market', 'Location', ''].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, card, prices }) => {
              const sellPrice = calculateSellPrice(prices?.tcgplayerMarket, item.sellPriceOverride, marginMultiplier)
              const isLow = item.quantity <= item.lowStockThreshold
              return (
                <tr key={item.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {card?.imageUrl ? (
                        <img
                          src={card.imageUrl}
                          alt={card.name}
                          className="w-8 h-11 object-contain flex-shrink-0 cursor-zoom-in hover:scale-110 transition-transform"
                          onClick={() => card && setZoomCard({
                            name: card.name,
                            setName: card.setName,
                            setNumber: card.setNumber,
                            variant: card.variant,
                            imageUrlLarge: card.imageUrlLarge,
                            imageUrl: card.imageUrl,
                            condition: item.condition,
                            tcgplayerMarket: prices?.tcgplayerMarket,
                            sellPrice: sellPrice ?? undefined,
                          })}
                          title="Click to zoom"
                        />
                      ) : (
                        <div className="w-8 h-11 bg-muted rounded flex-shrink-0" />
                      )}
                      <div>
                        <div
                          className="font-medium cursor-pointer hover:text-primary transition-colors"
                          onClick={() => card && setZoomCard({
                            name: card.name,
                            setName: card.setName,
                            setNumber: card.setNumber,
                            variant: card.variant,
                            imageUrlLarge: card.imageUrlLarge,
                            imageUrl: card.imageUrl,
                            condition: item.condition,
                            tcgplayerMarket: prices?.tcgplayerMarket,
                            sellPrice: sellPrice ?? undefined,
                          })}
                        >
                          {card?.name ?? '—'}
                        </div>
                        <div className="text-xs text-muted-foreground">{card?.setName} · #{card?.setNumber}</div>
                        {card?.variant && <div className="text-xs text-accent">{card.variant}</div>}
                        {item.defectNotes && <div className="text-xs text-orange-400 mt-0.5">{item.defectNotes}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${CONDITION_BADGE[item.condition] ?? 'border-border text-muted-foreground'}`}>
                      {item.condition}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      className={`w-16 h-7 text-center text-sm ${isLow ? 'border-destructive text-destructive' : ''}`}
                      value={item.id in editing ? editing[item.id] : item.quantity}
                      onChange={e => setEditing(prev => ({ ...prev, [item.id]: e.target.value }))}
                      onBlur={() => handleBlur(item.id, item.quantity)}
                      type="number"
                      min={0}
                    />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatGBP(item.costPrice)}</td>
                  <td className="px-4 py-3 font-semibold text-foreground">{formatGBP(sellPrice)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {prices?.isHighValue && <span className="text-destructive text-xs">⚠</span>}
                      <span className={prices?.isHighValue ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                        {formatGBP(prices?.tcgplayerMarket)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{item.location ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => onPrintQR(item.id)}>QR</Button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="p-12 text-center text-muted-foreground">No inventory items yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
