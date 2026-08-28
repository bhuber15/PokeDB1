// Imports a TCGplayer mobile-app collection export (app Settings → Default
// share format → CSV) straight into inventory. The app's columns are
// user-toggleable, so detection keys on distinctive header names rather than
// one fixed shape. Full header with everything on:
//   Quantity, Name, Simple Name, Set, Card Number, Set Code, Printing,
//   Condition, Language, Rarity, Product ID, SKU
// (some builds add Product Line for multi-game lists).
//
// Unlike the template path, rows that don't resolve to an existing catalogue
// card come back as row errors and are never created: TCGplayer's naming is
// not ours, and a thousand-row scan dump must not seed junk twins of
// catalogue cards. Cost imports as 0 — the scan can't know what was paid.
import { and, inArray, type SQL } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import { cards, inventoryItems } from '@/lib/db/schema'
import { normalizeName, similarity } from '@/lib/fuzzy'
import { generateQRId } from '@/lib/qr'
import type { Condition } from '@/lib/pricing'
import { isLanguage, type Game, type Language } from '@/lib/games'

const CONDITION_MAP: Record<string, Condition> = {
  'mint': 'M',
  'near mint': 'NM',
  'lightly played': 'LP',
  'moderately played': 'MP',
  'heavily played': 'HP',
  'damaged': 'DMG',
}

const LANGUAGE_MAP: Record<string, Language> = {
  'english': 'EN',
  'japanese': 'JA',
  'korean': 'KO',
  'chinese': 'ZH-CN',
  'chinese (s)': 'ZH-CN',
  'simplified chinese': 'ZH-CN',
  'chinese (t)': 'ZH-TW',
  'traditional chinese': 'ZH-TW',
}

// Product Line values seen in exports ("Magic: The Gathering", "YuGiOh",
// "Disney Lorcana"…), matched loosely on the normalized string.
const GAME_PATTERNS: [RegExp, Game][] = [
  [/pokemon/, 'pokemon'],
  [/magic/, 'mtg'],
  [/yugioh/, 'yugioh'],
  [/lorcana/, 'lorcana'],
]

export interface RowError { row: number; message: string }

type CatalogueCard = {
  id: number
  name: string
  game: string
  setName: string
  setNumber: string
  variant: string | null
  language: string
}

// `header` is the first CSV row, trimmed and lowercased (the route already
// normalizes it that way). Our own template always carries snake_case
// columns, so its presence wins over any TCGplayer-looking ones.
export function isTcgplayerExport(header: string[]): boolean {
  const h = new Set(header.map(c => c.replace(/^\uFEFF/, '')))
  if (h.has('set_number') || h.has('external_id') || h.has('cost_price')) return false
  return h.has('simple name') || h.has('product id') || h.has('product line') ||
    (h.has('printing') && (h.has('set code') || h.has('card number')))
}

// "125/197" → 125; "085/198" → 85 (pokemontcg.io numbers carry no slash or
// leading zeros, but tcgdex CJK rows keep zeros, so raw forms stay in the
// candidate set). The `extended` forms toggle the YGOPRODeck region segment
// ("LOB-001" ⇄ "LOB-EN001") — kept separate because both spellings can exist
// as genuinely distinct printings, and the code as printed must win before
// its regional cousin is even considered.
function numberCandidates(raw: string): { primary: string[]; extended: string[] } {
  const primary = new Set<string>()
  const add = (v: string) => { if (v) { primary.add(v); primary.add(v.toUpperCase()) } }
  const t = raw.trim()
  if (!t) return { primary: [], extended: [] }
  add(t)
  const numerator = (t.includes('/') ? t.slice(0, t.indexOf('/')) : t).trim()
  add(numerator)
  add(numerator.replace(/^0+(?=.)/, ''))
  const extended = new Set<string>()
  const m = numerator.toUpperCase().match(/^([A-Z0-9]+)-(?:[A-Z]{2})?(\d+)$/)
  if (m) {
    for (const v of [`${m[1]}-${m[2]}`, `${m[1]}-EN${m[2]}`]) {
      if (!primary.has(v)) extended.add(v)
    }
  }
  return { primary: [...primary], extended: [...extended] }
}

function listSome(items: string[], max = 3): string {
  return items.length <= max
    ? items.join('; ')
    : `${items.slice(0, max).join('; ')} …and ${items.length - max} more`
}

// Simple Name is the clean form; the Name column decorates ("Pikachu ex -
// 219/191", "Lightning Bolt (Borderless)"). Both plus a stripped Name go in.
function nameCandidates(simple: string, full: string): string[] {
  const out: string[] = []
  const push = (v: string) => { const t = v.trim(); if (t && !out.includes(t)) out.push(t) }
  push(simple)
  push(full)
  let stripped = full.trim().replace(/\s*-\s*\d+\/\d+$/, '')
  for (let prev = ''; prev !== stripped;) {
    prev = stripped
    stripped = stripped.replace(/\s*\([^()]*\)\s*$/, '')
  }
  push(stripped)
  return out
}

// 2 = exact (or a double-faced card's front face), 1 = near-identical.
function nameMatchTier(card: CatalogueCard, cands: string[]): number {
  const cn = normalizeName(card.name)
  let tier = 0
  for (const cand of cands) {
    const nn = normalizeName(cand)
    if (!nn) continue
    if (cn === nn) return 2
    if (card.name.includes('//') && normalizeName(card.name.split('//')[0]) === nn) return 2
    if (similarity(card.name, cand) >= 0.9) tier = Math.max(tier, 1)
  }
  return tier
}

// TCGplayer prefixes Pokémon sets with a code ("SV04: Paradox Rift") and
// says "Base Set" where the catalogue says "Base".
function normalizeSetName(s: string): string {
  return normalizeName(s.replace(/^[a-z0-9]{2,8}\s*:\s*/i, ''))
}

function narrowBySet(pool: CatalogueCard[], setVal: string): CatalogueCard[] {
  const targetRaw = normalizeName(setVal)
  if (!targetRaw) return pool
  const target = normalizeSetName(setVal)
  const exact = pool.filter(c => {
    const s = normalizeName(c.setName)
    return s === targetRaw || s === target
  })
  if (exact.length) return exact
  let loose = pool.filter(c => {
    const s = normalizeName(c.setName)
    return s.includes(target) || target.includes(s) || s.includes(targetRaw) || targetRaw.includes(s)
  })
  // "Base Set" must not drift onto "Base Set 2": a trailing digit is series
  // numbering, significant on whichever side carries it.
  if (loose.length > 1) {
    const targetDigit = /\d$/.test(target)
    const sameShape = loose.filter(c => /\d$/.test(normalizeName(c.setName)) === targetDigit)
    if (sameShape.length) loose = sameShape
  }
  if (loose.length) return loose
  const scored = pool
    .map(c => ({ c, score: similarity(c.setName, setVal) }))
    .sort((a, b) => b.score - a.score)
  if (scored[0] && scored[0].score >= 0.6 && (!scored[1] || scored[1].score < scored[0].score)) {
    return [scored[0].c]
  }
  return pool
}

const describe = (c: CatalogueCard) =>
  `${c.setName} #${c.setNumber}${c.variant ? ` ${c.variant}` : ''}`

// Same card in several finishes is deliberately several catalogue rows
// (cards.variant): MTG/Lorcana split by finish, YGO by rarity. Printing (or
// the Rarity column for YGO) decides which row the stock lands on.
function pickVariant(
  pool: CatalogueCard[], printingLow: string, rarity: string, displayName: string,
): { card?: CatalogueCard; error?: string } {
  if (pool.length === 1) return { card: pool[0] }
  if (new Set(pool.map(c => `${c.game}|${normalizeName(c.setName)}`)).size > 1) {
    return { error: `matches several sets (${listSome(pool.map(describe))}) — fill in the Set column` }
  }
  const game = pool[0].game
  if (game === 'mtg' || game === 'lorcana') {
    const etched = game === 'mtg' && /etched/.test(printingLow + normalizeName(displayName))
    const want = etched ? 'Etched' : /foil/.test(printingLow) ? 'Foil' : ''
    const hit = pool.find(c => (c.variant ?? '') === want)
    if (hit) return { card: hit }
    return { error: `no ${want || 'non-foil'} printing of "${displayName}" in the catalogue (have: ${pool.map(c => c.variant || 'non-foil').join(', ')})` }
  }
  if (game === 'yugioh' && rarity) {
    const rn = normalizeName(rarity)
    const exact = pool.filter(c => normalizeName(c.variant ?? '') === rn)
    if (exact.length === 1) return { card: exact[0] }
    const scored = pool
      .map(c => ({ c, score: similarity(c.variant ?? '', rarity) }))
      .sort((a, b) => b.score - a.score)
    if (scored[0].score >= 0.8 && (!scored[1] || scored[1].score < scored[0].score)) {
      return { card: scored[0].c }
    }
  }
  if (game === 'yugioh') {
    return { error: `several printings of "${displayName}" (${pool.map(c => c.variant || '?').join(', ')}) — turn on the Rarity column in the app` }
  }
  const base = pool.find(c => !(c.variant ?? ''))
  if (base) return { card: base }
  return { error: `ambiguous match: ${pool.map(describe).join('; ')}` }
}

// The seller-portal flavours of TCGplayer CSVs fold printing into condition
// ("Near Mint Holofoil", "Lightly Played 1st Edition") — strip those words
// off and let them stand in for Printing when that column is missing.
function parseCondition(raw: string): { condition?: Condition; foilHint: boolean } {
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  let foilHint = false
  for (let prev = ''; prev !== s;) {
    prev = s
    const m = s.match(/^(.*?)\s+(foil|holofoil|reverse holofoil|1st edition|unlimited|etched)$/)
    if (m) {
      if (/foil|etched/.test(m[2])) foilHint = true
      s = m[1]
    }
  }
  return { condition: CONDITION_MAP[s], foilHint }
}

export async function importTcgplayerExport(
  rows: string[][], dbc: Db,
): Promise<{ created: number; createdIds: number[]; errors: RowError[] }> {
  const header = rows[0].map(h => h.replace(/^\uFEFF/, '').trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const col = (r: string[], name: string) => { const i = idx(name); return i >= 0 ? (r[i] ?? '').trim() : '' }

  const fail = (message: string) => ({ created: 0, createdIds: [], errors: [{ row: 1, message }] })
  if (idx('simple name') < 0 && idx('name') < 0) {
    return fail('export has no Name column — turn on Name in the TCGplayer app’s CSV output settings')
  }
  if (idx('condition') < 0) {
    return fail('export has no Condition column — turn on Condition in the TCGplayer app’s CSV output settings')
  }

  interface Pending {
    rowNo: number
    names: string[]
    displayName: string
    fullName: string
    numbers: { primary: string[]; extended: string[] }
    setVal: string
    printingLow: string
    rarity: string
    game: Game | null
    language: Language
    condition: Condition
    quantity: number
  }

  const errors: RowError[] = []
  const pending: Pending[] = []

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const rowNo = i + 1
    const simple = col(r, 'simple name')
    const full = col(r, 'name')
    const names = nameCandidates(simple, full)
    if (!names.length) { errors.push({ row: rowNo, message: 'missing card name' }); continue }
    const displayName = simple || names[0]

    const { condition, foilHint } = parseCondition(col(r, 'condition'))
    if (!condition) {
      errors.push({ row: rowNo, message: `bad condition "${col(r, 'condition')}"` })
      continue
    }

    const qtyRaw = col(r, 'quantity')
    const quantity = idx('quantity') < 0 || qtyRaw === '' ? 1 : parseInt(qtyRaw, 10)
    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push({ row: rowNo, message: `bad quantity "${qtyRaw}"` })
      continue
    }

    const langRaw = col(r, 'language')
    let language: Language = 'EN'
    if (langRaw) {
      const mapped = LANGUAGE_MAP[langRaw.toLowerCase()] ?? (isLanguage(langRaw.toUpperCase()) ? langRaw.toUpperCase() as Language : undefined)
      if (!mapped) { errors.push({ row: rowNo, message: `unsupported language "${langRaw}"` }); continue }
      language = mapped
    }

    let game: Game | null = null
    const lineRaw = col(r, 'product line')
    if (lineRaw) {
      const ln = normalizeName(lineRaw)
      game = GAME_PATTERNS.find(([re]) => re.test(ln))?.[1] ?? null
      if (!game) { errors.push({ row: rowNo, message: `unsupported product line "${lineRaw}"` }); continue }
    }

    pending.push({
      rowNo, names, displayName, fullName: full,
      numbers: numberCandidates(col(r, 'card number')),
      setVal: col(r, 'set'),
      printingLow: (col(r, 'printing').toLowerCase() || (foilHint ? 'foil' : '')),
      rarity: col(r, 'rarity'),
      game, language, condition, quantity,
    })
  }

  // One bulk catalogue fetch instead of a query per row: everything sharing
  // any candidate set number (or, for rows without one, an exact name), then
  // resolve in memory. Filtered to the languages/games the file mentions.
  const languages = [...new Set(pending.map(p => p.language))]
  const games = pending.every(p => p.game) ? [...new Set(pending.map(p => p.game!))] : null
  const scope: SQL[] = []
  if (languages.length) scope.push(inArray(cards.language, languages))
  if (games) scope.push(inArray(cards.game, games))
  const selection = {
    id: cards.id, name: cards.name, game: cards.game, setName: cards.setName,
    setNumber: cards.setNumber, variant: cards.variant, language: cards.language,
  }

  const byNumber = new Map<string, CatalogueCard[]>()
  const byName = new Map<string, CatalogueCard[]>()
  const allNumbers = [...new Set(pending.flatMap(p => [...p.numbers.primary, ...p.numbers.extended]))]
  const fallbackNames = [...new Set(pending.filter(p => !p.numbers.primary.length).flatMap(p => p.names))]
  const CHUNK = 400
  for (let i = 0; i < allNumbers.length; i += CHUNK) {
    const found = await dbc.select(selection).from(cards)
      .where(and(inArray(cards.setNumber, allNumbers.slice(i, i + CHUNK)), ...scope))
    for (const c of found) {
      const key = c.setNumber.toUpperCase()
      byNumber.set(key, [...(byNumber.get(key) ?? []), c])
    }
  }
  for (let i = 0; i < fallbackNames.length; i += CHUNK) {
    const found = await dbc.select(selection).from(cards)
      .where(and(inArray(cards.name, fallbackNames.slice(i, i + CHUNK)), ...scope))
    for (const c of found) {
      const key = normalizeName(c.name)
      byName.set(key, [...(byName.get(key) ?? []), c])
    }
  }

  const resolved: { rowNo: number; cardId: number; condition: Condition; quantity: number }[] = []
  for (const p of pending) {
    const dedupe = (cs: CatalogueCard[]) => {
      const seen = new Set<number>()
      return cs.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    }
    const inScope = (c: CatalogueCard) => c.language === p.language && (!p.game || c.game === p.game)
    let pool: CatalogueCard[]
    if (p.numbers.primary.length) {
      pool = dedupe(p.numbers.primary.flatMap(n => byNumber.get(n.toUpperCase()) ?? [])).filter(inScope)
      // The regional respellings ("LOB-001" → "LOB-EN001") only get a look
      // when the code as printed matches nothing — both can exist as
      // genuinely distinct printings.
      if (!pool.length) {
        pool = dedupe(p.numbers.extended.flatMap(n => byNumber.get(n.toUpperCase()) ?? [])).filter(inScope)
      }
    } else {
      pool = dedupe(p.names.flatMap(n => byName.get(normalizeName(n)) ?? [])).filter(inScope)
    }
    if (!pool.length) {
      errors.push({ row: p.rowNo, message: `no catalogue match for "${p.displayName}"${p.numbers.primary.length ? ` #${p.numbers.primary[0]}` : ''}` })
      continue
    }

    const best = Math.max(...pool.map(c => nameMatchTier(c, p.names)))
    if (best > 0) {
      pool = pool.filter(c => nameMatchTier(c, p.names) === best)
    } else if (!(pool.length === 1 && p.names.some(n => similarity(pool[0].name, n) >= 0.5))) {
      // Covers a wrong name at a right number AND a card whose set simply
      // isn't in the catalogue (yet) — don't claim to know which.
      const at = `#${p.numbers.primary[0] ?? '?'}${p.setVal ? ` (${p.setVal})` : ''}`
      errors.push({ row: p.rowNo, message: `"${p.displayName}" ${at} not found in the catalogue — closest at that number: ${listSome(pool.map(c => `${c.name} — ${describe(c)}`))}` })
      continue
    }

    if (pool.length > 1 && p.setVal) pool = narrowBySet(pool, p.setVal)

    const picked = pickVariant(pool, p.printingLow, p.rarity, p.displayName || p.fullName)
    if (!picked.card) {
      errors.push({ row: p.rowNo, message: picked.error ?? 'ambiguous match' })
      continue
    }
    resolved.push({ rowNo: p.rowNo, cardId: picked.card.id, condition: p.condition, quantity: p.quantity })
  }

  // The app emits a row per scan, so the same card/condition can repeat —
  // merge those into one inventory line instead of stacking duplicates.
  const merged = new Map<string, { cardId: number; condition: Condition; quantity: number }>()
  for (const r of resolved) {
    const key = `${r.cardId}|${r.condition}`
    const existing = merged.get(key)
    if (existing) existing.quantity += r.quantity
    else merged.set(key, { cardId: r.cardId, condition: r.condition, quantity: r.quantity })
  }

  const items = [...merged.values()]
  const createdIds: number[] = []
  if (items.length) {
    await dbc.transaction(async (tx) => {
      for (let i = 0; i < items.length; i += 100) {
        const ret = await tx.insert(inventoryItems).values(items.slice(i, i + 100).map(it => ({
          cardId: it.cardId,
          condition: it.condition,
          quantity: it.quantity,
          costPrice: 0, // unknown for scanned legacy stock; edit later if it matters
          qrCode: generateQRId(),
        }))).returning({ id: inventoryItems.id })
        createdIds.push(...ret.map(r => r.id))
      }
    })
  }

  errors.sort((a, b) => a.row - b.row)
  return { created: items.length, createdIds, errors }
}
