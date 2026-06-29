// app/api/sales/history/route.ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sales, staff } from '@/lib/db/schema'
import { eq, sql, gte } from 'drizzle-orm'
import { getSession } from '@/lib/auth'

export async function GET() {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const [todayStats] = await db.select({
    totalRevenue: sql<number>`COALESCE(SUM(total), 0)`,
    saleCount: sql<number>`COUNT(*)`,
    cashTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0)`,
    cardTotal: sql<number>`COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0)`,
  }).from(sales).where(gte(sales.createdAt, todayStart.toISOString()))

  const recentSales = await db
    .select({ sale: sales, staffName: staff.name })
    .from(sales)
    .leftJoin(staff, eq(sales.staffId, staff.id))
    .orderBy(sql`${sales.createdAt} DESC`)
    .limit(25)

  return NextResponse.json({ todayStats, recentSales })
}
