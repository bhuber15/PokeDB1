'use client'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatGBP } from '@/lib/pricing'
import type { InventoryValuation, AgedStockRow, LowStockRow } from '@/lib/domain/reports'

interface StockData {
  valuation: InventoryValuation
  lowStock: LowStockRow[]
  agedStock: AgedStockRow[]
}

const AGED_OPTIONS = [90, 180, 365]

export function StockSection() {
  const [agedDays, setAgedDays] = useState(90)
  const [data, setData] = useState<StockData | null>(null)

  useEffect(() => {
    fetch(`/api/reports/inventory?agedDays=${agedDays}`)
      .then(async res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }, [agedDays])

  if (!data) return null
  const { valuation, lowStock, agedStock } = data

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Stock</h2>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          {
            label: 'Units in stock',
            value: String(valuation.totalUnits),
            hint: `${valuation.distinctItems} items`,
          },
          {
            label: 'Value at cost',
            value: formatGBP(valuation.costValue),
            hint: valuation.unitsWithoutCost > 0 ? `${valuation.unitsWithoutCost} units have no cost` : undefined,
          },
          {
            label: 'Value at market',
            value: formatGBP(valuation.marketValue),
            hint: valuation.unitsWithoutMarket > 0 ? `${valuation.unitsWithoutMarket} units have no market price` : undefined,
          },
        ].map(stat => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
              {stat.hint && <div className="text-xs text-muted-foreground mt-1">{stat.hint}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Low stock — reorder list</h3>
        {lowStock.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-3">Nothing at or below its low-stock threshold.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30">
                <tr>
                  {['Card', 'Cond.', 'Location', 'Qty', 'Min'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {lowStock.map(r => (
                  <tr key={r.inventoryItemId}>
                    <td className="px-3 py-2">
                      {r.cardName ?? 'Unknown'}
                      {r.setName && <span className="text-muted-foreground"> · {r.setName}</span>}
                    </td>
                    <td className="px-3 py-2">{r.condition}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.location ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{r.quantity}</td>
                    <td className="px-3 py-2 tabular-nums text-right">{r.lowStockThreshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Aged stock — no movement in {agedDays} days</h3>
          <div className="flex gap-1">
            {AGED_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => setAgedDays(d)}
                className={`px-2 py-1 text-xs rounded border ${d === agedDays ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        {agedStock.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-3">No dead stock older than {agedDays} days.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30">
                <tr>
                  {['Card', 'Cond.', 'Qty', 'Cost', 'Added', 'Last sold'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {agedStock.map(r => (
                  <tr key={r.inventoryItemId}>
                    <td className="px-3 py-2">
                      {r.cardName ?? 'Unknown'}
                      {r.setName && <span className="text-muted-foreground"> · {r.setName}</span>}
                    </td>
                    <td className="px-3 py-2">{r.condition}</td>
                    <td className="px-3 py-2 tabular-nums">{r.quantity}</td>
                    <td className="px-3 py-2 tabular-nums">{r.costPrice == null ? '—' : formatGBP(r.costPrice * r.quantity)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.createdAt.slice(0, 10)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground text-right">{r.lastSoldAt ? r.lastSoldAt.slice(0, 10) : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
