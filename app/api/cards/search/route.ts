import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { searchCards } from '@/lib/domain/card-search'

// Catalogue-first card search (buylist, stock intake, want lists). Returns
// `{ cards, prices, fuzzy, unavailable }` — see lib/domain/card-search.ts for
// the search cascade and result cap.
export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ cards: [], prices: {}, fuzzy: false, unavailable: false })
  }

  return NextResponse.json(await searchCards(q))
})
