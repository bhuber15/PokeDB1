'use client'
import { Fragment, useState } from 'react'
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

interface Group {
  key: string
  card: Card | null
  condition: string
  prices: PriceCache | null
  items: InventoryRow[]
  totalQty: number
}

// Group identical card + condition into one display row (each physical item is kept
// underneath, expandable, so per-item QR/cost/location are still accessible).
function groupRows(rows: InventoryRow[]): Group[] {
  const map = new Map<string, Group>()
  for (const row of rows) {
    const key = `${row.item.cardId ?? 'x'}|${row.item.condition}`
    let g = map.get(key)
    if (!g) {
      g = { key, card: row.card, condition: row.item.condition, prices: row.prices, items: [], totalQty: 0 }
      map.set(key, g)
    }
    g.items.push(row)
    g.totalQty += row.item.quantity
  }
  return [...map.values()]
}

export function InventoryTable({ rows, onStockChange, onPrintQR }: InventoryTableProps) {
  const [editId, setEditId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [zoomCard, setZoomCard] = useState<CardZoomData | null>(null)
  const { marginMultiplier } = useSettings()

  const groups = groupRows(rows)

  function startEdit(id: number, current: number) {
    setEditId(id)
    setDraft(String(current))
  }
  function saveEdit(id: number, current: number) {
    const val = parseInt(draft)
    if (!isNaN(val) && val >= 0 && val !== current) onStockChange(id, val)
    setEditId(null)
  }
  function toggleExpand(key: string) {
    setExpanded(prev => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })
  }

  function StockCell({ item }: { item: InventoryItem }) {
    const isLow = item.quantity <= item.lowStockThreshold
    if (editId === item.id) {
      return (
        <div className="flex items-center gap-1">
          <Input
            className="w-16 h-7 text-center text-sm"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveEdit(item.id, item.quantity)
              if (e.key === 'Escape') setEditId(null)
            }}
            type="number"
            min={0}
            autoFocus
          />
          <Button variant="ghost" size="sm" className="h-7 px-1.5 text-emerald-400" onClick={() => saveEdit(item.id, item.quantity)} aria-label="Save stock">✓</Button>
          <Button variant="ghost" size="sm" className="h-7 px-1.5 text-muted-foreground" onClick={() => setEditId(null)} aria-label="Cancel">✕</Button>
        </div>
      )
    }
    return (
      <button
        className={`inline-flex items-center gap-1.5 h-7 px-2 rounded hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isLow ? 'text-destructive' : ''}`}
        onClick={() => startEdit(item.id, item.quantity)}
        aria-label={`Edit stock, currently ${item.quantity}${isLow ? ', low stock' : ''}`}
      >
        <span className="font-medium tabular-nums">{item.quantity}</span>
        {isLow && <span className="text-xs">low</span>}
        <span className="text-xs text-muted-foreground opacity-60" aria-hidden="true">✎</span>
      </button>
    )
  }

  return (
    <>
      <CardZoomModal card={zoomCard} onClose={() => setZoomCard(null)} />
      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30">
            <tr>
              {['Card', 'Condition', 'Stock', 'Sell Price', 'TCG Market', ''].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(group => {
              const { card, prices } = group
              const sellPrice = calculateSellPrice(prices?.tcgplayerMarket, group.items[0].item.sellPriceOverride, marginMultiplier)
              const multi = group.items.length > 1
              const isOpen = expanded.has(group.key)
              const zoom = () => card && setZoomCard({
                name: card.name, setName: card.setName, setNumber: card.setNumber,
                variant: card.variant, imageUrlLarge: card.imageUrlLarge, imageUrl: card.imageUrl,
                condition: group.condition, tcgplayerMarket: prices?.tcgplayerMarket, sellPrice: sellPrice ?? undefined,
              })
              return (
                <Fragment key={group.key}>
                  <tr className="border-b border-border/50 last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {card?.imageUrl ? (
                          <button type="button" onClick={zoom} aria-label={`Zoom ${card.name}`}
                            className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <img src={card.imageUrl} alt="" width={32} height={44}
                              className="w-8 h-11 object-contain cursor-zoom-in hover:scale-110 transition-transform" />
                          </button>
                        ) : (
                          <div className="w-8 h-11 bg-muted rounded flex-shrink-0" />
                        )}
                        <div>
                          {card ? (
                            <button type="button" onClick={zoom}
                              className="font-medium hover:text-primary transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                              {card.name}
                            </button>
                          ) : (
                            <div className="font-medium">—</div>
                          )}
                          <div className="text-xs text-muted-foreground">{card?.setName} · #{card?.setNumber}</div>
                          {card?.variant && <div className="text-xs text-accent">{card.variant}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${CONDITION_BADGE[group.condition] ?? 'border-border text-muted-foreground'}`}>
                        {group.condition}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {multi ? (
                        <span className="font-medium tabular-nums">{group.totalQty}</span>
                      ) : (
                        <StockCell item={group.items[0].item} />
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold text-foreground tabular-nums">{formatGBP(sellPrice)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {prices?.isHighValue && <span className="text-destructive text-xs" aria-hidden="true">⚠</span>}
                        <span className={`tabular-nums ${prices?.isHighValue ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                          {formatGBP(prices?.tcgplayerMarket)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {multi ? (
                        <Button variant="ghost" size="sm" className="text-xs" onClick={() => toggleExpand(group.key)}>
                          {isOpen ? 'Hide' : `${group.items.length} items`} <span aria-hidden="true">{isOpen ? '▲' : '▼'}</span>
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-xs" onClick={() => onPrintQR(group.items[0].item.id)}>QR</Button>
                      )}
                    </td>
                  </tr>
                  {multi && isOpen && group.items.map(({ item }) => (
                    <tr key={item.id} className="border-b border-border/50 bg-muted/10 text-xs">
                      <td className="px-4 py-2 pl-16 text-muted-foreground">
                        {item.location ? item.location : 'no location'}{item.defectNotes ? ` · ${item.defectNotes}` : ''}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">cost {formatGBP(item.costPrice)}</td>
                      <td className="px-4 py-2"><StockCell item={item} /></td>
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2">
                        <Button variant="ghost" size="sm" className="text-xs" onClick={() => onPrintQR(item.id)}>QR</Button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              )
            })}
            {groups.length === 0 && (
              <tr><td colSpan={6} className="p-12 text-center text-muted-foreground">No inventory items yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
