// app/api/sales/history/route.ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, staff } from '@/lib/db/schema'
import { eq, sql, gte } from 'drizzle-orm'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async () => {
  requireAdmin(await getSession())

  // createdAt is stored via SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, space separator).
  // Compare against the same format — a JS toISOString() ("...T...Z") sorts differently and would
  // silently exclude every sale.
  const [todayStats] = await db.select({
    totalRevenue: sql<number>`COALESCE(SUM(total), 0)`,
    saleCount: sql<number>`COUNT(*)`,
    cashTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0)`,
    cardTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0)`,
  }).from(sales).where(gte(sales.createdAt, sql`datetime('now','start of day')`))

  const recentSales = await db
    .select({ sale: sales, staffName: staff.name })
    .from(sales)
    .leftJoin(staff, eq(sales.staffId, staff.id))
    .orderBy(sql`${sales.createdAt} DESC`)
    .limit(25)

  return NextResponse.json({ todayStats, recentSales })
})
