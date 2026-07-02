import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, staff } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { toCSV } from '@/lib/csv'

export const GET = guarded(async () => {
  requireAdmin(await getSession())
  const rows = await db.select({ sale: sales, staffName: staff.name })
    .from(sales).leftJoin(staff, eq(sales.staffId, staff.id))
    .orderBy(desc(sales.createdAt))
  const csv = toCSV(
    ['sale_id', 'datetime', 'staff', 'payment_method', 'subtotal', 'discount', 'vat', 'total'],
    rows.map(({ sale, staffName }) => [
      sale.id, sale.createdAt, staffName ?? '', sale.paymentMethod,
      sale.subtotal, sale.discountAmount, sale.vatAmount, sale.total,
    ]),
  )
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sales-${date}.csv"`,
    },
  })
})
