import { db } from '@/lib/db'
import { creditLedger } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

// NOTE: calculateBuyPrice moved to lib/pricing.ts (pure, no DB) so client
// components can import it without pulling the libSQL client into the browser.

export async function getCustomerBalance(customerId: number): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.customerId, customerId))
  return row?.balance ?? 0 // SUM of integer pence is integer pence
}
