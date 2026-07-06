// One-time: populate cards.series for rows imported before the column
// existed. Fetches the full Pokemon TCG API set list once (174 sets, a
// single request — not a per-card sweep) and updates cards.series by
// matching set_name. Safe to re-run: only touches rows where series IS NULL.
import './load-env'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../lib/db'
import { cards } from '../lib/db/schema'
import { fetchSets } from '../lib/apis/pokemon-tcg'

async function main() {
  const sets = await fetchSets()
  const bySetName = new Map(sets.map(s => [s.name, s.series]))

  const localSetNames = await db.selectDistinct({ setName: cards.setName }).from(cards)

  let matched = 0
  let unmatched = 0
  for (const { setName } of localSetNames) {
    const series = bySetName.get(setName)
    if (!series) {
      console.log(`no API match for set "${setName}" — leaving series NULL`)
      unmatched++
      continue
    }
    await db.update(cards)
      .set({ series })
      .where(and(eq(cards.setName, setName), isNull(cards.series)))
    matched++
  }
  console.log(`Done: ${matched} sets matched and updated, ${unmatched} sets had no API match.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
