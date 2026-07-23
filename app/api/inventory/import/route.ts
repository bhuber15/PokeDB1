import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { cards, inventoryItems, priceCache } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseCSV } from '@/lib/csv'
import { generateQRId } from '@/lib/qr'
import { parsePounds, CONDITIONS } from '@/lib/pricing'
import { isLanguage, GAME_IDS, type Game, type Language } from '@/lib/games'

const CONDITION_SET = new Set<string>(CONDITIONS)

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))

  const text = await req.text()
  const rows = parseCSV(text)
  if (rows.length < 2) return NextResponse.json({ error: 'Empty or header-only CSV' }, { status: 400 })

  const header = rows[0].map(h => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const col = (r: string[], name: string) => { const i = idx(name); return i >= 0 ? r[i]?.trim() : '' }

  const errors: { row: number; message: string }[] = []
  let created = 0
  const createdIds: number[] = [] // for batch label printing after import

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNo = i + 1
    try {
      const condition = col(r, 'condition')?.toUpperCase()
      const quantity = parseInt(col(r, 'quantity'))
      const costPrice = parseFloat(col(r, 'cost_price'))
      const externalId = col(r, 'external_id') || null
      const name = col(r, 'name') || null
      const setName = col(r, 'set_name') || null
      const setNumber = col(r, 'set_number') || null
      // Optional identity columns; omitting them keeps pre-existing CSVs
      // importing exactly as before (the catalogue defaults: EN Pokémon).
      const gameRaw = col(r, 'game')?.toLowerCase()
      const game = (gameRaw || 'pokemon') as Game
      if (!(GAME_IDS as readonly string[]).includes(game)) throw new Error(`bad game "${gameRaw}"`)
      const languageRaw = col(r, 'language')?.toUpperCase()
      const language = (languageRaw || 'EN') as Language
      if (!isLanguage(language)) throw new Error(`bad language "${languageRaw}"`)

      if (!CONDITION_SET.has(condition)) throw new Error(`bad condition "${condition}"`)
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('bad quantity')
      if (!(costPrice >= 0)) throw new Error('bad cost_price')

      const sellOverrideRaw = col(r, 'sell_price_override')
      let sellPriceOverride: number | null = null
      if (sellOverrideRaw) {
        const parsed = parseFloat(sellOverrideRaw)
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error('bad sell_price_override')
        sellPriceOverride = parsePounds(parsed) // CSV column is pounds
      }

      await db.transaction(async (tx) => {
        let cardId: number | null = null
        if (externalId) {
          const [c] = await tx.select().from(cards).where(eq(cards.externalId, externalId)).limit(1)
          if (c) cardId = c.id
        }
        if (!cardId && name && setNumber) {
          // Identity-scoped: a JA "Pikachu 025" must never resolve to (or
          // create a duplicate of) the EN printing with the same name/number.
          const [c] = await tx.select().from(cards)
            .where(and(eq(cards.name, name), eq(cards.setNumber, setNumber),
              eq(cards.game, game), eq(cards.language, language))).limit(1)
          if (c) cardId = c.id
        }
        if (!cardId) {
          if (!name || !setNumber) throw new Error('no card match and missing name/set_number to create one')
          const [c] = await tx.insert(cards).values({
            name, setName: setName ?? '', setNumber, externalId, game, language,
          }).returning()
          cardId = c.id
          await tx.insert(priceCache).values({ cardId }).onConflictDoNothing()
        }

        const [item] = await tx.insert(inventoryItems).values({
          cardId, condition, quantity, costPrice: parsePounds(costPrice), // CSV column is pounds
          sellPriceOverride,
          qrCode: generateQRId(),
          location: col(r, 'location') || null,
          defectNotes: col(r, 'defect_notes') || null,
        }).returning()
        createdIds.push(item.id)
      })
      created++
    } catch (e) {
      errors.push({ row: rowNo, message: e instanceof Error ? e.message : 'error' })
    }
  }
  return NextResponse.json({ created, createdIds, errors })
})
