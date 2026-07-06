import { NextRequest, NextResponse } from 'next/server'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { searchPokemonCards } from '@/lib/apis/pokemon-tcg'

// Deliberately live-API-only, unlike /api/cards/search (catalogue-first): the
// prices page shows per-variant TCGplayer price breakdowns, rarity and types,
// which the local catalogue doesn't store. Cap of 30 is also deliberate —
// each result fans out into a Cardmarket fetch client-side, and the upstream
// API slows down at larger page sizes. The catalogue search returns up to
// CARD_SEARCH_LIMIT (lib/domain/card-search.ts).
export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  // Never 500 the client on a transient upstream failure (including the
  // client's 4s timeout) — return an empty list with an `unavailable` flag
  // and log the real error server-side.
  try {
    const cards = await searchPokemonCards(q, 30)
    return NextResponse.json({ cards })
  } catch (e) {
    console.error('Price lookup failed for', q, '→', e)
    return NextResponse.json({ cards: [], unavailable: true })
  }
})
