// app/api/sales/search/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { searchSales } from '@/lib/domain/sales-search'

// Sales history search (returns desk): ?q= receipt # / card / customer,
// ?from= / ?to= YYYY-MM-DD. Same admin gate as the history endpoint.
export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const params = req.nextUrl.searchParams
  const results = await searchSales({
    q: params.get('q') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  }, db)
  return NextResponse.json({ results })
})
