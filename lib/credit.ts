import { db } from '@/lib/db'
import { creditLedger } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

// Floor so we never overpay a customer by a rounding penny.
export function calculateBuyPrice(market: number | null | undefined, pct: number): number | null {
  if (market == null) return null
  return Math.floor(market * pct * 100) / 100
}

export async function getCustomerBalance(customerId: number): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.customerId, customerId))
  return Math.round((row?.balance ?? 0) * 100) / 100
}
