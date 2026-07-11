// app/api/reports/margin-stock-book/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getMarginStockBook } from '@/lib/domain/reports'
import { toCSV } from '@/lib/csv'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const gbp = (p: number | null) => (p == null ? '' : (p / 100).toFixed(2))

export const GET = guarded(async (req: NextRequest) => {
  requireAdmin(await getSession())

  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be before to' }, { status: 400 })
  }

  const rows = await getMarginStockBook(from, to)
  const csv = toCSV(
    ['Sale #', 'Sold at', 'Card', 'Condition', 'Qty', 'Cost (£)', 'Sale (£)', 'Margin (£)', 'VAT (£)', 'No cost basis'],
    rows.map(r => [
      r.saleId, r.soldAt, r.cardName ?? 'Unknown', r.condition, r.quantity,
      gbp(r.costPence), gbp(r.salePence), gbp(r.marginPence), gbp(r.vatPence),
      r.noCostBasis ? 'YES' : '',
    ]),
  )

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="margin-stock-book-${from}_to_${to}.csv"`,
    },
  })
})
