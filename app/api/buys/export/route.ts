import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { toCSV } from '@/lib/csv'
import { getBuyExportRows } from '@/lib/domain/reports'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const rows = await getBuyExportRows(db)
  const csv = toCSV(
    ['buy_id', 'datetime', 'staff', 'customer', 'method', 'txn_total', 'card', 'condition', 'quantity', 'pay_price_each', 'market_at_buy'],
    // CSV money columns are pounds (human-facing, opened in Excel)
    rows.map(r => [
      r.buyId, r.createdAt, r.staffName ?? '', r.customerName ?? '', r.method,
      (r.txnTotal / 100).toFixed(2), r.cardName ?? '', r.condition, r.quantity,
      (r.payPrice / 100).toFixed(2), r.marketAtBuy == null ? '' : (r.marketAtBuy / 100).toFixed(2),
    ]),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="buys-${date}.csv"`,
    },
  })
})
