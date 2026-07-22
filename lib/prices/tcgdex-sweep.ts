import { like, inArray, sql } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards } from '@/lib/db/schema'
import { fetchTcgdexSets, fetchTcgdexSet } from '@/lib/apis/tcgdex'
import { tcgdexExternalId } from '@/lib/sources/external-id'
import { TCGDEX_LANGS, NON_EN_LANGUAGES } from '@/lib/games'
import { chunked } from '@/lib/prices/sync'
import type { AppSettings } from '@/lib/settings'

export interface TcgdexSweepResult {
  setsChecked: number
  setsImported: number
  setsFailed: number
  cardsSeen: number
  newCards: number
}

export interface TcgdexSweepDeps {
  fetchSets?: typeof fetchTcgdexSets
  fetchSet?: typeof fetchTcgdexSet
}

const CHUNK = 100

// Catalogue rows for the enabled CJK languages, from TCGdex set briefs.
// Cheap by design: one set-list request per language, then one request per
// set that is missing cards locally (count vs cardCount.total) — a nightly
// run after the initial import only fetches newly released sets. Prices and
// alias_name are NOT written here; both ride the per-card rotation
// (lib/prices/sync.ts), because dexId and pricing live on the per-card
// endpoint only. Idempotent; per-set failure isolation.
export async function sweepTcgdexCatalogue(
  settings: AppSettings,
  dbc: Db = db,
  deps: TcgdexSweepDeps = {},
  onSet?: (setId: string, result: TcgdexSweepResult) => void,
): Promise<TcgdexSweepResult> {
  const fetchSets = deps.fetchSets ?? fetchTcgdexSets
  const fetchSet = deps.fetchSet ?? fetchTcgdexSet
  const result: TcgdexSweepResult = { setsChecked: 0, setsImported: 0, setsFailed: 0, cardsSeen: 0, newCards: 0 }

  const languages = NON_EN_LANGUAGES.filter(l => settings.enabledLanguages.includes(l))
  for (const language of languages) {
    const tcgdexLang = TCGDEX_LANGS[language]
    let sets
    try {
      sets = await fetchSets(tcgdexLang)
    } catch {
      result.setsFailed++ // set list unreachable — count once, move to next language
      continue
    }
    for (const set of sets) {
      result.setsChecked++
      try {
        const prefix = tcgdexExternalId(language, `${set.id}-`)
        const [{ n }] = await dbc.select({ n: sql<number>`count(*)` }).from(cards)
          .where(like(cards.externalId, `${prefix}%`))
        if (n >= set.cardCount.total) continue // complete — skip

        const detail = await fetchSet(tcgdexLang, set.id)
        if (!detail) continue // vanished between list and fetch
        result.setsImported++
        result.cardsSeen += detail.cards.length

        const ids = detail.cards.map(c => tcgdexExternalId(language, c.id))
        const existing = await dbc.select({ externalId: cards.externalId }).from(cards)
          .where(inArray(cards.externalId, ids))
        const known = new Set(existing.map(r => r.externalId))
        result.newCards += ids.filter(id => !known.has(id)).length

        for (const chunk of chunked(detail.cards, CHUNK)) {
          await dbc.insert(cards).values(chunk.map(c => ({
            name: c.name,
            game: 'pokemon',
            language,
            setName: detail.name,
            setNumber: c.localId,
            series: detail.serie?.name ?? null,
            variant: null,
            externalId: tcgdexExternalId(language, c.id),
            imageUrl: c.image ? `${c.image}/low.webp` : null,
            imageUrlLarge: c.image ? `${c.image}/high.webp` : null,
          }))).onConflictDoUpdate({
            target: cards.externalId,
            // Heal identity fields on re-import; never clobber aliasName —
            // it is backfilled by the per-card sync.
            set: {
              name: sql`excluded.name`,
              setName: sql`excluded.set_name`,
              setNumber: sql`excluded.set_number`,
              series: sql`excluded.series`,
              imageUrl: sql`excluded.image_url`,
              imageUrlLarge: sql`excluded.image_url_large`,
            },
          })
        }
      } catch {
        result.setsFailed++ // bad set — keep sweeping the rest
      }
      onSet?.(set.id, result)
    }
  }
  return result
}
