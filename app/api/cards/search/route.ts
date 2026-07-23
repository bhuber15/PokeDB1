import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { searchCards } from '@/lib/domain/card-search'
import { isLanguage, GAME_IDS, type Game } from '@/lib/games'

// Catalogue-first card search (buylist, stock intake, want lists). Returns
// `{ cards, prices, fuzzy, unavailable }` — see lib/domain/card-search.ts for
// the search cascade and result cap. Optional `game`/`language` query params
// scope the search; unrecognised values are ignored rather than 400ing.
export const GET = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ cards: [], prices: {}, fuzzy: false, unavailable: false })
  }

  const langParam = req.nextUrl.searchParams.get('language')
  const gameParam = req.nextUrl.searchParams.get('game')
  const filters = {
    ...(langParam && isLanguage(langParam) ? { language: langParam } : {}),
    ...(gameParam && (GAME_IDS as readonly string[]).includes(gameParam) ? { game: gameParam as Game } : {}),
  }
  return NextResponse.json(await searchCards(q, db, {}, filters))
})
