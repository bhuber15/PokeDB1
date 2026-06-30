import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { searchPokemonCards } from '@/lib/apis/pokemon-tcg'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ cards: [] })

  const cards = await searchPokemonCards(q, 60)
  return NextResponse.json({ cards })
}
