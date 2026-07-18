'use client'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatGBP } from '@/lib/pricing'
import { DateRangePicker } from '@/components/reports/DateRangePicker'
import { RefundDialog } from '@/components/reports/RefundDialog'
import { VoidSaleDialog } from '@/components/reports/VoidSaleDialog'
import { CashUpSection } from '@/components/reports/CashUpSection'
import { StockSection } from '@/components/reports/StockSection'

interface TodayStats {
  totalRevenue: number
  saleCount: number
  cashTotal: number
  cardTotal: number
}

interface RecentSale {
  sale: { id: number; total: number; paymentMethod: string; discountAmount: number; createdAt: string; voidedAt: string | null }
  staffName: string | null
  itemsSummary: string
}

interface RangeSummary {
  range: { from: string; to: string }
  revenue: number
  subtotal: number
  discountTotal: number
  vatTotal: number
  grossMargin: number
  saleCount: number
  byPaymentMethod: { paymentMethod: string; total: number }[]
  byStaff: { staffId: number | null; staffName: string | null; saleCount: number; revenue: number; margin: number; noCostLines: number }[]
  topCards: { cardId: number; name: string; quantitySold: number; revenue: number }[]
}

export default function ReportsPage() {
  const [data, setData] = useState<{ todayStats: TodayStats; recentSales: RecentSale[] } | null>(null)

  useEffect(() => {
    fetch('/api/sales/history').then(async res => {
      if (!res.ok) {
        console.error('Failed to load report data', res.status)
        return
      }
      return res.json()
    }).then(data => data && setData(data))
  }, [])

  const todayISO = new Date().toISOString().slice(0, 10)
  const [range, setRange] = useState({ from: todayISO, to: todayISO })
  const [summary, setSummary] = useState<RangeSummary | null>(null)
  const [refundSaleId, setRefundSaleId] = useState<number | null>(null)
  const [voidSaleId, setVoidSaleId] = useState<number | null>(null)

  useEffect(() => {
    fetch(`/api/reports/sales?from=${range.from}&to=${range.to}`)
      .then(async res => (res.ok ? res.json() : null))
      .then(setSummary)
  }, [range.from, range.to])

  if (!data) return <p className="text-muted-foreground">Loading…</p>

  const { todayStats, recentSales } = data

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reports</h1>
        <div className="flex gap-2">
          <a href="/api/reports/sales/export"><Button variant="outline">Export Sales CSV</Button></a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API-route file download, not a page navigation */}
          <a href="/api/buys/export"><Button variant="outline">Export Buys CSV</Button></a>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Today's Revenue", value: formatGBP(todayStats.totalRevenue) },
          { label: 'Sales Today', value: String(todayStats.saleCount) },
          { label: 'Cash Total', value: formatGBP(todayStats.cashTotal) },
          { label: 'Card Total', value: formatGBP(todayStats.cardTotal) },
        ].map(stat => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Range Summary</h2>
          <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
        </div>
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Revenue', value: formatGBP(summary.revenue) },
              { label: 'Gross Margin', value: formatGBP(summary.grossMargin) },
              { label: 'VAT', value: formatGBP(summary.vatTotal) },
              { label: 'Sales', value: String(summary.saleCount) },
            ].map(stat => (
              <Card key={stat.label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {summary && summary.byStaff.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30">
                <tr>
                  {['Staff', 'Sales', 'Revenue', 'Margin'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {summary.byStaff.map((s, i) => (
                  <tr key={s.staffId ?? `null-${i}`}>
                    <td className="px-3 py-2">{s.staffName ?? 'Unassigned'}</td>
                    <td className="px-3 py-2 tabular-nums">{s.saleCount}</td>
                    <td className="px-3 py-2 tabular-nums">{formatGBP(s.revenue)}</td>
                    <td className="px-3 py-2 tabular-nums text-right" title={s.noCostLines > 0 ? `${s.noCostLines} line(s) had no cost basis and are excluded` : undefined}>
                      {formatGBP(s.margin)}{s.noCostLines > 0 && <span className="text-muted-foreground">*</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {summary && summary.topCards.length > 0 && (
          <div className="border rounded-lg divide-y">
            {summary.topCards.map(c => (
              <div key={c.cardId} className="flex items-center justify-between p-3 text-sm">
                <span>{c.name}</span>
                <span className="text-muted-foreground">{c.quantitySold} sold · {formatGBP(c.revenue)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <CashUpSection />

      <StockSection />

      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Sales</h2>
        <div className="border rounded-lg divide-y">
          {recentSales.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No sales yet</p>
          )}
          {recentSales.map(({ sale, staffName, itemsSummary }) => (
            <div key={sale.id} className={`flex items-center justify-between p-3 ${sale.voidedAt ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`font-semibold shrink-0 ${sale.voidedAt ? 'line-through' : ''}`}>{formatGBP(sale.total)}</span>
                <Badge variant="outline" className="shrink-0">{sale.paymentMethod}</Badge>
                {sale.voidedAt && <Badge variant="destructive" className="shrink-0">Voided</Badge>}
                {sale.discountAmount > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">-{formatGBP(sale.discountAmount)} disc.</span>
                )}
                <span className="text-sm text-muted-foreground truncate">{itemsSummary}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right text-sm">
                  <div className="text-muted-foreground">{staffName ?? 'Unknown'}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(sale.createdAt).toLocaleString('en-GB', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                </div>
                {!sale.voidedAt && (
                  <>
                    {sale.createdAt.slice(0, 10) === todayISO && (
                      <Button size="sm" variant="outline" onClick={() => setVoidSaleId(sale.id)}>Void</Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setRefundSaleId(sale.id)}>Refund</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <RefundDialog
        saleId={refundSaleId}
        open={refundSaleId !== null}
        onClose={() => setRefundSaleId(null)}
        onDone={() => fetch('/api/sales/history').then(r => r.json()).then(setData)}
      />

      <VoidSaleDialog
        saleId={voidSaleId}
        open={voidSaleId !== null}
        onClose={() => setVoidSaleId(null)}
        onDone={() => fetch('/api/sales/history').then(r => r.json()).then(setData)}
      />
    </div>
  )
}
