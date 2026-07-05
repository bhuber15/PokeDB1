// One-time repair for card rows whose externalId doesn't match their name
// (the original seed data derived externalIds from invented set numbers, so
// ~half the seeded stock points at the wrong card/image).
//
// For every card with active stock or an open want, it verifies the
// externalId against the Pokemon TCG API. When the API disagrees with the
// stored name, it re-matches by name against the already-imported catalogue,
// repoints active inventory and open wants to the correct card row, and
// neutralises the bad row (externalId + images cleared, name kept).
//
// Dry run (prints the plan, writes nothing):  npx tsx scripts/repair-card-links.ts
// Apply:                                      npx tsx scripts/repair-card-links.ts --apply
// Run BEFORE re-running scripts/import-catalogue.ts.
import './load-env'
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm'
import { db } from '../lib/db'
import { cards, inventoryItems, wantList } from '../lib/db/schema'

const APPLY = process.argv.includes('--apply')
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

async function fetchApiCard(externalId: string): Promise<{ name: string } | null> {
  const key = process.env.POKEMON_TCG_API_KEY
  const res = await fetch(
    `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(externalId)}?select=id,name`,
    { headers: key ? { 'X-Api-Key': key } : {} },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}`)
  return (await res.json()).data
}

async function main() {
  // Cards that matter: attached to active stock or an open want
  const suspects = await db.selectDistinct({
    id: cards.id, name: cards.name, setName: cards.setName, externalId: cards.externalId,
  }).from(cards)
    .leftJoin(inventoryItems, and(eq(inventoryItems.cardId, cards.id), eq(inventoryItems.isActive, true)))
    .leftJoin(wantList, and(eq(wantList.cardId, cards.id), isNull(wantList.fulfilledAt)))
    .where(and(isNotNull(cards.externalId), sql`(${inventoryItems.id} IS NOT NULL OR ${wantList.id} IS NOT NULL)`))

  // Name index over the full catalogue for re-matching
  const all = await db.select({
    id: cards.id, name: cards.name, setName: cards.setName, externalId: cards.externalId,
  }).from(cards).where(isNotNull(cards.externalId))
  const byName = new Map<string, typeof all>()
  for (const c of all) {
    const k = norm(c.name)
    const arr = byName.get(k) ?? []
    arr.push(c)
    byName.set(k, arr)
  }

  let healthy = 0, repointed = 0, unresolved = 0
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — checking ${suspects.length} cards…\n`)

  for (const c of suspects) {
    await new Promise(r => setTimeout(r, 150)) // be gentle on the free API
    let api: { name: string } | null
    try {
      api = await fetchApiCard(c.externalId!)
    } catch (e) {
      console.log(`?  [${c.id}] "${c.name}" — API error, skipped (${e})`)
      continue
    }
    if (api && norm(api.name) === norm(c.name)) { healthy++; continue }

    // externalId is wrong for this name — find the real card in the catalogue
    const candidates = (byName.get(norm(c.name)) ?? []).filter(x => x.id !== c.id)
    const verified: typeof candidates = []
    for (const cand of candidates) {
      const candApi = await fetchApiCard(cand.externalId!).catch(() => null)
      if (candApi && norm(candApi.name) === norm(cand.name)) verified.push(cand)
      await new Promise(r => setTimeout(r, 150))
    }
    const sameSet = verified.filter(x => norm(x.setName) === norm(c.setName))
    const target = sameSet[0] ?? verified[0]

    if (!target) {
      unresolved++
      console.log(`✗  [${c.id}] "${c.name}" (${c.setName}) ext=${c.externalId} → API says "${api?.name ?? 'NOT FOUND'}"; no catalogue match by name — clearing bad image, FIX MANUALLY`)
      if (APPLY) {
        await db.update(cards).set({ externalId: null, imageUrl: null, imageUrlLarge: null })
          .where(eq(cards.id, c.id))
      }
      continue
    }

    repointed++
    console.log(`→  [${c.id}] "${c.name}" (${c.setName}) ext=${c.externalId} was "${api?.name ?? 'NOT FOUND'}" — repointing stock/wants to [${target.id}] "${target.name}" (${target.setName}, ${target.externalId})`)
    if (APPLY) {
      await db.update(inventoryItems).set({ cardId: target.id })
        .where(and(eq(inventoryItems.cardId, c.id), eq(inventoryItems.isActive, true)))
      await db.update(wantList).set({ cardId: target.id })
        .where(and(eq(wantList.cardId, c.id), isNull(wantList.fulfilledAt)))
      await db.update(cards).set({ externalId: null, imageUrl: null, imageUrlLarge: null })
        .where(eq(cards.id, c.id))
    }
  }

  console.log(`\ndone: ${healthy} healthy · ${repointed} repointed · ${unresolved} unresolved${APPLY ? '' : '  (dry run — re-run with --apply to write)'}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
