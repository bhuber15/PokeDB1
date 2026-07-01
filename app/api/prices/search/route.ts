import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { searchPokemonCards } from '@/lib/apis/pokemon-tcg'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  // Never 500 the client on a transient upstream failure — return an empty list
  // with an `unavailable` flag and log the real error server-side.
  try {
    const cards = await searchPokemonCards(q, 30)
    return NextResponse.json({ cards })
  } catch (e) {
    console.error('Price lookup failed for', q, '→', e)
    return NextResponse.json({ cards: [], unavailable: true })
  }
}
