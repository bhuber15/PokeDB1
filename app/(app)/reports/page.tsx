'use client'
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatGBP, parsePounds } from '@/lib/pricing'
import { DateRangePicker } from '@/components/reports/DateRangePicker'
import { RefundDialog } from '@/components/reports/RefundDialog'

interface TodayStats {
  totalRevenue: number
  saleCount: number
  cashTotal: number
  cardTotal: number
}

interface RecentSale {
  sale: { id: number; total: number; paymentMethod: string; discountAmount: number; createdAt: string }
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
  byStaff: { staffId: number | null; staffName: string | null; saleCount: number; revenue: number }[]
  topCards: { cardId: number; name: string; quantitySold: number; revenue: number }[]
}

interface CashUp {
  cashSales: number
  cashRefunds: number
  cashBuyPayouts: number
}

// Expected drawer = float + cash sales − cash refunds − cash buylist payouts
function CashUpSection() {
  const [cashUp, setCashUp] = useState<CashUp | null>(null)
  const [float, setFloat] = useState('')

  useEffect(() => {
    fetch('/api/reports/cash-up')
      .then(async res => (res.ok ? res.json() : null))
      .then(setCashUp)
  }, [])

  if (!cashUp) return null
  const floatPence = parsePounds(float || '0')
  const expected = floatPence + cashUp.cashSales - cashUp.cashRefunds - cashUp.cashBuyPayouts

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Cash Up — Today</h2>
      <Card>
        <CardContent className="pt-6 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="cash-up-float" className="text-muted-foreground font-normal">Opening float (£)</Label>
            <Input
              id="cash-up-float"
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              value={float}
              onChange={e => setFloat(e.target.value)}
              placeholder="0.00"
              className="w-28 h-8 text-right"
            />
          </div>
          <div className="flex justify-between"><span className="text-muted-foreground">+ Cash sales</span><span className="tabular-nums">{formatGBP(cashUp.cashSales)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">− Cash refunds</span><span className="tabular-nums">{cashUp.cashRefunds > 0 ? `−${formatGBP(cashUp.cashRefunds)}` : formatGBP(0)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">− Cash buylist payouts</span><span className="tabular-nums">{cashUp.cashBuyPayouts > 0 ? `−${formatGBP(cashUp.cashBuyPayouts)}` : formatGBP(0)}</span></div>
          <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
            <span>Expected in drawer</span><span className="tabular-nums">{formatGBP(expected)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
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
        <a href="/api/reports/sales/export"><Button variant="outline">Export CSV</Button></a>
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
                  {['Staff', 'Sales', 'Revenue'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {summary.byStaff.map((s, i) => (
                  <tr key={s.staffId ?? `null-${i}`}>
                    <td className="px-3 py-2">{s.staffName ?? 'Unassigned'}</td>
                    <td className="px-3 py-2 tabular-nums">{s.saleCount}</td>
                    <td className="px-3 py-2 tabular-nums text-right">{formatGBP(s.revenue)}</td>
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

      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Sales</h2>
        <div className="border rounded-lg divide-y">
          {recentSales.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No sales yet</p>
          )}
          {recentSales.map(({ sale, staffName, itemsSummary }) => (
            <div key={sale.id} className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-semibold shrink-0">{formatGBP(sale.total)}</span>
                <Badge variant="outline" className="shrink-0">{sale.paymentMethod}</Badge>
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
                <Button size="sm" variant="outline" onClick={() => setRefundSaleId(sale.id)}>Refund</Button>
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
    </div>
  )
}
