# Multi-language Pokémon catalogue (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell, buy, and stock JA/KO/ZH-CN/ZH-TW Pokémon singles: TCGdex CJK catalogues imported behind a per-tenant language setting, language-aware search with English species aliases, and the full no-price workflow (intake nudge, till quick-set, manual buy offers).

**Architecture:** Activate the dormant `cards.game`/`cards.language` columns through import → search → POS. New TCGdex set-brief sweep creates CJK rows with source-qualified external ids (`tcgdex:ja:SV4a-006`); the existing per-card nightly rotation is generalized to dispatch on the id's source, fetch both TCGdex pricing blocks, and piggyback the `alias_name` backfill. Live checks (2026-07-22) show TCGdex has **no pricing for JP-exclusive sets** — CJK stock runs override-first, which the POS/buylist tasks make fast. Spec: `docs/superpowers/specs/2026-07-22-multi-game-multi-language-catalogue-design.md`.

**Tech Stack:** Next.js App Router, Drizzle ORM (Turso/SQLite), zod, node:test via tsx, Playwright.

## Global Constraints

- All money is **integer pence**; pounds→pence only via `parsePounds` at the UI edge.
- Prices are **server-canonical**; `createSale`'s `NO_PRICE` guard is untouched.
- Every route: `guarded()` + zod `parseBody()` where a body exists; routes call `const db = await getTenantDb()` and pass it down — never import the `db` singleton in a route.
- Client components **never value-import** `lib/domain/*` or anything touching `lib/db`; shared constants live in dependency-free `lib/games.ts` (`import type` is fine).
- DB `language` values are **uppercase** (`'EN' | 'JA' | 'KO' | 'ZH-CN' | 'ZH-TW'`); lowercase codes inside `tcgdex:…` external ids are TCGdex's namespace.
- Existing bare external ids (`xy7-54`) are grandfathered pokemontcg.io EN — **never rewritten**.
- `'EN'` is always a member of `enabledLanguages`.
- Tests: colocated `*.test.ts`, node:test + `assert/strict`, in-memory DB via `createTestDb()`/`seedBase()` from `@/lib/db/test-helpers`. Run all: `npm test`; single file: `npx tsx --test lib/prices/tcgdex-sweep.test.ts`.
- UK English in copy.
- Work on the current worktree branch (`claude/kind-cannon-457cb0` — it already carries the spec and this plan); the PR goes up from it.

---

### Task 1: Language constants, schema (`alias_name` + index + setting), migration 0021, settings plumbing

**Files:**
- Create: `lib/games.ts`
- Modify: `lib/db/schema.ts` (cards: `aliasName` column + `(game, language)` index; settings: `enabledLanguages` column)
- Modify: `lib/settings.ts` (AppSettings field, parse/serialize)
- Modify: `lib/settings.test.ts` (exists — extend it, reusing its imports)
- Modify: `lib/prices/sync.test.ts` (its `SETTINGS: AppSettings` literal gains the new required field)
- Generate: `lib/db/migrations/0021_*.sql` via drizzle-kit

**Interfaces:**
- Produces: `GAME_IDS`, `Game`, `LANGUAGES`, `Language`, `LANGUAGE_LABELS`, `TCGDEX_LANGS`, `NON_EN_LANGUAGES`, `isLanguage()` (from `@/lib/games`); `cards.aliasName: string | null`; `AppSettings.enabledLanguages: Language[]`.

- [ ] **Step 1: Write `lib/games.ts`**

```ts
// Game and language constants shared by the import pipeline (server) and
// badges/filters (client) — keep this module dependency-free so it never
// drags the DB client into a browser bundle (see lib/adjustment-reasons.ts).
export const GAME_IDS = ['pokemon'] as const // phase 2 adds more games (spec §6)
export type Game = (typeof GAME_IDS)[number]

// DB `cards.language` values. Uppercase, matching the existing 'EN' default.
export const LANGUAGES = ['EN', 'JA', 'KO', 'ZH-CN', 'ZH-TW'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<Language, string> = {
  EN: 'English',
  JA: 'Japanese',
  KO: 'Korean',
  'ZH-CN': 'Chinese (Simplified)',
  'ZH-TW': 'Chinese (Traditional)',
}

// Languages whose Pokémon catalogue comes from TCGdex (EN stays on
// pokemontcg.io), mapped to TCGdex URL path codes.
export const TCGDEX_LANGS: Record<Exclude<Language, 'EN'>, string> = {
  JA: 'ja',
  KO: 'ko',
  'ZH-CN': 'zh-cn',
  'ZH-TW': 'zh-tw',
}
export const NON_EN_LANGUAGES = Object.keys(TCGDEX_LANGS) as Exclude<Language, 'EN'>[]

export function isLanguage(x: unknown): x is Language {
  return typeof x === 'string' && (LANGUAGES as readonly string[]).includes(x)
}
```

- [ ] **Step 2: Edit `lib/db/schema.ts`**

Add `index` to the `drizzle-orm/sqlite-core` import. In `cards`, after the `language` line add:

```ts
  // EN species name for CJK printings (from the TCGdex dexId) — search-only.
  // Null for EN rows, trainers/energy, and special arts without a dex number.
  aliasName: text('alias_name'),
```

and give the table an extras callback (it currently has none — add the second argument):

```ts
}, (t) => [index('idx_cards_game_language').on(t.game, t.language)])
```

In `settings`, appended at the end of the column list (a plain ADD COLUMN migration), add:

```ts
  // JSON array of Language codes (lib/games.ts). 'EN' is always a member.
  enabledLanguages: text('enabled_languages').notNull().default('["EN"]'),
```

- [ ] **Step 3: Generate migration**

```bash
npx drizzle-kit generate --name multilang-pokemon
```

Expected: `lib/db/migrations/0021_multilang-pokemon.sql` containing `ALTER TABLE cards ADD alias_name text;`, `ALTER TABLE settings ADD enabled_languages text DEFAULT '["EN"]' NOT NULL;`, and `CREATE INDEX idx_cards_game_language ...`. If the shell has `TURSO_*` vars set, unset them first (migration/deploy gotcha).

- [ ] **Step 4: Write the failing settings test**

Add to the existing `lib/settings.test.ts` (reuse its imports; add any missing ones):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from '@/lib/db/test-helpers'
import { getSettings, updateSettings } from '@/lib/settings'

test('enabledLanguages defaults to EN and round-trips through updateSettings', async () => {
  const db = await createTestDb()
  const initial = await getSettings(db)
  assert.deepEqual(initial.enabledLanguages, ['EN'])

  const updated = await updateSettings({ enabledLanguages: ['EN', 'JA', 'KO'] }, db)
  assert.deepEqual(updated.enabledLanguages, ['EN', 'JA', 'KO'])
  assert.deepEqual((await getSettings(db)).enabledLanguages, ['EN', 'JA', 'KO'])
})

test('malformed enabled_languages JSON degrades to [EN], never throws', async () => {
  const db = await createTestDb()
  await getSettings(db) // create the row
  await db.run(`UPDATE settings SET enabled_languages = 'not json' WHERE id = 1`)
  assert.deepEqual((await getSettings(db)).enabledLanguages, ['EN'])
})
```

(If `db.run` with a raw string doesn't match the `Db` type, use `` db.run(sql`UPDATE settings SET enabled_languages = 'not json' WHERE id = 1`) `` with `import { sql } from 'drizzle-orm'`.)

- [ ] **Step 5: Run test to verify it fails**

Run: `npx tsx --test lib/settings.test.ts`
Expected: FAIL — `enabledLanguages` missing from `AppSettings`.

- [ ] **Step 6: Wire settings**

In `lib/settings.ts`:

```ts
import { type Language, isLanguage } from '@/lib/games'
```

Add to `AppSettings`: `enabledLanguages: Language[]`. Add to `DEFAULT_SETTINGS`: `enabledLanguages: ['EN'],`.

Add above `toAppSettings`:

```ts
// enabled_languages is a JSON text column; tolerate junk (['EN'] fallback)
// and guarantee 'EN' membership so the EN catalogue can never be disabled.
function parseLanguages(json: string): Language[] {
  try {
    const arr: unknown = JSON.parse(json)
    const langs = Array.isArray(arr) ? arr.filter(isLanguage) : []
    return langs.includes('EN') ? langs : ['EN', ...langs]
  } catch {
    return ['EN']
  }
}
```

In `toAppSettings` add: `enabledLanguages: parseLanguages(row.enabledLanguages),`.

`getSettings` creates the row with `{ id: 1, ...DEFAULT_SETTINGS }` — the array must not reach the text column. Change both write paths to serialize:

```ts
// Row-shaped copy of an AppSettings patch: arrays become JSON text.
function toRow(patch: Partial<AppSettings>) {
  const { enabledLanguages, ...rest } = patch
  return {
    ...rest,
    ...(enabledLanguages ? { enabledLanguages: JSON.stringify(enabledLanguages) } : {}),
  }
}
```

- in `getSettings`: `.values({ id: 1, ...toRow(DEFAULT_SETTINGS) })`
- in `updateSettings`: `.set({ ...toRow(patch), updatedAt: ... })`

`AppSettings` gained a required field, so the one full literal in the codebase must be updated too — in `lib/prices/sync.test.ts`, add to the `SETTINGS` const:

```ts
  enabledLanguages: ['EN'],
```

- [ ] **Step 7: Run tests**

Run: `npx tsx --test lib/settings.test.ts` → PASS. Then `npm test` → all green (the test DB migrates via `applyMigrations`, picking up 0021).

- [ ] **Step 8: Commit**

```bash
git add lib/games.ts lib/db/schema.ts lib/db/migrations lib/settings.ts lib/settings.test.ts
git commit -m "feat: language constants, cards.alias_name + (game,language) index, enabledLanguages setting (migration 0021)"
```

---

### Task 2: External-id helpers + TCGdex client extensions

**Files:**
- Create: `lib/sources/external-id.ts`, `lib/sources/external-id.test.ts`
- Modify: `lib/apis/tcgdex.ts` (language-aware base URL; set/card fetchers; pricing extraction)
- Create: `lib/apis/tcgdex.test.ts`

**Interfaces:**
- Consumes: `Language`, `isLanguage` from Task 1.
- Produces: `tcgdexExternalId(language, rawId): string`, `parseExternalId(externalId): ParsedExternalId` (from `@/lib/sources/external-id`); `fetchTcgdexSets(tcgdexLang)`, `fetchTcgdexSet(tcgdexLang, setId)`, `fetchTcgdexCard(tcgdexLang, rawId)`, `extractTcgdexPricing(data)`, types `TcgdexSetBrief`, `TcgdexSetDetail`, `TcgdexCardBrief`, `TcgdexCardData` (from `@/lib/apis/tcgdex`). Existing `fetchCardmarketPrices` behavior unchanged.

- [ ] **Step 1: Write failing external-id tests**

`lib/sources/external-id.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { tcgdexExternalId, parseExternalId } from '@/lib/sources/external-id'

test('bare ids parse as pokemontcg (grandfathered EN rows)', () => {
  assert.deepEqual(parseExternalId('xy7-54'), { source: 'pokemontcg', id: 'xy7-54' })
})

test('tcgdex ids round-trip with case preserved on the raw id', () => {
  const ext = tcgdexExternalId('JA', 'SV4a-006')
  assert.equal(ext, 'tcgdex:ja:SV4a-006')
  assert.deepEqual(parseExternalId(ext), { source: 'tcgdex', language: 'JA', id: 'SV4a-006' })
})

test('zh-cn code (contains a hyphen) round-trips', () => {
  assert.deepEqual(parseExternalId(tcgdexExternalId('ZH-CN', 'abc-1')),
    { source: 'tcgdex', language: 'ZH-CN', id: 'abc-1' })
})

test('malformed tcgdex prefix falls back to pokemontcg parse', () => {
  assert.deepEqual(parseExternalId('tcgdex:xx:foo'), { source: 'pokemontcg', id: 'tcgdex:xx:foo' })
})
```

Run: `npx tsx --test lib/sources/external-id.test.ts` → FAIL (module not found).

- [ ] **Step 2: Write `lib/sources/external-id.ts`**

```ts
import { type Language, isLanguage } from '@/lib/games'

// Bare ids ("xy7-54") are grandfathered pokemontcg.io EN rows — never
// rewritten (the nightly sweep's onConflict targets them). New sources are
// namespaced: tcgdex:<lang>:<raw id, case preserved — TCGdex set ids are
// mixed-case ("SV4a") and we fetch with the id verbatim>.
export type ParsedExternalId =
  | { source: 'pokemontcg'; id: string }
  | { source: 'tcgdex'; language: Language; id: string }

export function tcgdexExternalId(language: Exclude<Language, 'EN'>, rawId: string): string {
  return `tcgdex:${language.toLowerCase()}:${rawId}`
}

export function parseExternalId(externalId: string): ParsedExternalId {
  if (externalId.startsWith('tcgdex:')) {
    const rest = externalId.slice('tcgdex:'.length)
    // Language codes may contain a hyphen but never a colon.
    const sep = rest.indexOf(':')
    if (sep > 0) {
      const language = rest.slice(0, sep).toUpperCase()
      const id = rest.slice(sep + 1)
      if (isLanguage(language) && id) return { source: 'tcgdex', language, id }
    }
  }
  return { source: 'pokemontcg', id: externalId }
}
```

- [ ] **Step 3: Run external-id tests** → PASS.

- [ ] **Step 4: Write failing TCGdex extraction tests**

`lib/apis/tcgdex.test.ts` (pure extraction only — network fns stay thin):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTcgdexPricing } from '@/lib/apis/tcgdex'

test('null pricing blocks (JP-exclusive sets) → dexId kept, no prices', () => {
  const r = extractTcgdexPricing({ dexId: [930], pricing: { cardmarket: null, tcgplayer: null } }, null)
  assert.deepEqual(r, { dexId: [930], cardmarket: null, tcgplayer: null })
})

test('cardmarket block: zeros are no-data; holo variant prefers -holo keys', () => {
  const data = {
    pricing: { cardmarket: { trend: 0, low: 2.5, avg: 3, 'trend-holo': 9, 'low-holo': 8, 'avg-holo': 8.5 } },
  }
  const base = extractTcgdexPricing(data, null)
  assert.deepEqual(base.cardmarket, { trend: null, low: 2.5, avg: 3 })
  const holo = extractTcgdexPricing(data, 'Holofoil')
  assert.deepEqual(holo.cardmarket, { trend: 9, low: 8, avg: 8.5 })
})

test('tcgplayer block: variant-keyed, holofoil preferred, USD fields mapped', () => {
  const r = extractTcgdexPricing({
    pricing: {
      tcgplayer: {
        unit: 'USD',
        normal: { marketPrice: 1, lowPrice: 0.5, midPrice: 1.2, highPrice: 3 },
        holofoil: { marketPrice: 28.62, lowPrice: 25.08, midPrice: 32.91, highPrice: 59.99 },
      },
    },
  }, null)
  assert.deepEqual(r.tcgplayer, { market: 28.62, low: 25.08, mid: 32.91, high: 59.99 })
})

test('missing pricing key entirely → both blocks null', () => {
  assert.deepEqual(extractTcgdexPricing({}, null), { dexId: null, cardmarket: null, tcgplayer: null })
})
```

Run: `npx tsx --test lib/apis/tcgdex.test.ts` → FAIL (`extractTcgdexPricing` not exported).

- [ ] **Step 5: Extend `lib/apis/tcgdex.ts`**

Replace the `BASE` const with a language-aware helper (the existing `fetchCardmarketPrices` keeps its exact behavior by using `'en'`):

```ts
const base = (tcgdexLang: string) => `https://api.tcgdex.net/v2/${tcgdexLang}`
```

(and change the existing fetch in `fetchCardmarketPrices` from `` `${BASE}/cards/...` `` to `` `${base('en')}/cards/...` ``.)

Add a shared JSON fetcher with the client's existing error semantics (404 → null, transient → `TcgdexError`):

```ts
async function fetchTcgdexJson<T>(url: string): Promise<T | null> {
  let res: Response
  try {
    res = await fetch(url, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(TCGDEX_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TcgdexError(`TCGdex unreachable for ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new TcgdexError(`TCGdex ${res.status} for ${url}`)
  try {
    return await res.json() as T
  } catch {
    throw new TcgdexError(`TCGdex returned malformed JSON for ${url}`)
  }
}
```

Add the catalogue types and fetchers (shapes verified live 2026-07-22):

```ts
export interface TcgdexSetBrief {
  id: string
  name: string
  cardCount: { total: number; official: number }
}

export interface TcgdexCardBrief {
  id: string       // e.g. "SV4a-006" — case preserved
  localId: string  // e.g. "006"
  name: string     // localized
  image?: string   // base URL — append /low.webp or /high.webp
}

export interface TcgdexSetDetail {
  id: string
  name: string
  releaseDate?: string
  serie?: { id: string; name: string }
  cards: TcgdexCardBrief[]
}

export async function fetchTcgdexSets(tcgdexLang: string): Promise<TcgdexSetBrief[]> {
  return (await fetchTcgdexJson<TcgdexSetBrief[]>(`${base(tcgdexLang)}/sets`)) ?? []
}

export async function fetchTcgdexSet(tcgdexLang: string, setId: string): Promise<TcgdexSetDetail | null> {
  return fetchTcgdexJson<TcgdexSetDetail>(`${base(tcgdexLang)}/sets/${encodeURIComponent(setId)}`)
}
```

Add the per-card data fetcher + pure extraction. Distinctions that matter: **`null` return = card unknown (404)**; **object with null blocks = TCGdex answered, no marketplace data** (the JP-exclusive norm — the caller still gets `dexId` for the alias backfill); throws `TcgdexError` on transient failure.

```ts
interface TcgdexTcgplayerVariant {
  marketPrice?: number; lowPrice?: number; midPrice?: number; highPrice?: number
}

export interface TcgdexCardData {
  dexId: number[] | null
  cardmarket: { trend: number | null; low: number | null; avg: number | null } | null // EUR
  tcgplayer: { market: number | null; low: number | null; mid: number | null; high: number | null } | null // USD
}

// TCGdex emits 0 for prices it doesn't have — 0 is "no data", not a price.
const pos = (v: number | null | undefined): number | null => (v && v > 0 ? v : null)

export function extractTcgdexPricing(
  data: { dexId?: number[]; pricing?: { cardmarket?: TcgdexCardmarket | null; tcgplayer?: Record<string, unknown> | null } },
  variant: string | null | undefined,
): TcgdexCardData {
  const cm = data.pricing?.cardmarket ?? null
  let cardmarket: TcgdexCardData['cardmarket'] = null
  if (cm) {
    const holo = isHolo(variant)
    const trend = pos((holo ? cm['trend-holo'] : cm.trend) ?? cm.trend)
    const low = pos((holo ? cm['low-holo'] : cm.low) ?? cm.low)
    const avg = pos((holo ? cm['avg-holo'] : cm.avg) ?? cm.avg)
    if (trend != null || low != null || avg != null) cardmarket = { trend, low, avg }
  }

  const tpBlock = data.pricing?.tcgplayer ?? null
  let tcgplayer: TcgdexCardData['tcgplayer'] = null
  if (tpBlock) {
    // Variant-keyed like pokemontcg.io; prefer holo-ish printings, else first present.
    const candidates = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal']
    let v: TcgdexTcgplayerVariant | undefined
    for (const k of candidates) {
      const b = tpBlock[k]
      if (b && typeof b === 'object') { v = b as TcgdexTcgplayerVariant; break }
    }
    if (!v) v = Object.values(tpBlock).find((b): b is TcgdexTcgplayerVariant => !!b && typeof b === 'object')
    if (v) {
      const market = pos(v.marketPrice); const low = pos(v.lowPrice)
      const mid = pos(v.midPrice); const high = pos(v.highPrice)
      if (market != null || low != null || mid != null || high != null) tcgplayer = { market, low, mid, high }
    }
  }

  return { dexId: data.dexId?.length ? data.dexId : null, cardmarket, tcgplayer }
}

// Full card fetch for the price rotation + alias backfill. Uses the raw id
// verbatim — TCGdex CJK ids are mixed-case; do NOT lowercase (that is an
// EN-only quirk of fetchCardmarketPrices).
export async function fetchTcgdexCard(tcgdexLang: string, rawId: string): Promise<TcgdexCardData | null> {
  const data = await fetchTcgdexJson<{ dexId?: number[]; pricing?: { cardmarket?: TcgdexCardmarket | null; tcgplayer?: Record<string, unknown> | null } }>(
    `${base(tcgdexLang)}/cards/${encodeURIComponent(rawId)}`)
  if (!data) return null
  return extractTcgdexPricing(data, null)
}
```

(`extractTcgdexPricing` takes `variant` for symmetry with the EN holo heuristic; `fetchTcgdexCard` passes `null` — CJK rows have no variant in phase 1.)

Refactor note: `fetchCardmarketPrices` keeps its current export, signature, and semantics — the existing EN path and its tests must not change behavior. It may share `fetchTcgdexJson` internally if the diff stays small; otherwise leave it verbatim.

- [ ] **Step 6: Run tests**

Run: `npx tsx --test lib/apis/tcgdex.test.ts lib/sources/external-id.test.ts` → PASS. Then `npm test` → green (proves `fetchCardmarketPrices` untouched behavior).

- [ ] **Step 7: Commit**

```bash
git add lib/sources lib/apis/tcgdex.ts lib/apis/tcgdex.test.ts
git commit -m "feat: source-qualified external ids + TCGdex set/card fetchers with dual-block price extraction"
```

---

### Task 3: EN species alias table (script + data + lookup)

**Files:**
- Create: `scripts/generate-pokedex-aliases.ts`
- Create: `lib/data/pokedex-en.json` (generated, committed)
- Create: `lib/pokedex.ts`, `lib/pokedex.test.ts`

**Interfaces:**
- Produces: `aliasForDexIds(dexIds: number[] | null | undefined): string | null` from `@/lib/pokedex`.

- [ ] **Step 1: Write failing lookup test**

`lib/pokedex.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { aliasForDexIds } from '@/lib/pokedex'

test('maps a dex id to the EN species name', () => {
  assert.equal(aliasForDexIds([6]), 'Charizard')
})

test('multi-species cards use the first id; unknown/empty → null', () => {
  assert.equal(aliasForDexIds([25, 26]), 'Pikachu')
  assert.equal(aliasForDexIds([999999]), null)
  assert.equal(aliasForDexIds(null), null)
  assert.equal(aliasForDexIds([]), null)
})

test('special names survive generation', () => {
  assert.equal(aliasForDexIds([122]), 'Mr. Mime')
  assert.equal(aliasForDexIds([250]), 'Ho-Oh')
})
```

Run: `npx tsx --test lib/pokedex.test.ts` → FAIL.

- [ ] **Step 2: Write the generation script**

`scripts/generate-pokedex-aliases.ts`:

```ts
// One-off: generate lib/data/pokedex-en.json (dex id → EN species name) from
// PokeAPI. The JSON is committed — builds and imports never hit PokeAPI.
//   npx tsx scripts/generate-pokedex-aliases.ts
import { writeFileSync } from 'node:fs'

// Slug→display fixes where naive Title Case is wrong. Aliases are search
// data, so minor cosmetic misses beyond this list are acceptable.
const SPECIAL: Record<string, string> = {
  'mr-mime': 'Mr. Mime', 'mime-jr': 'Mime Jr.', 'mr-rime': 'Mr. Rime',
  farfetchd: "Farfetch'd", sirfetchd: "Sirfetch'd",
  'ho-oh': 'Ho-Oh', 'porygon-z': 'Porygon-Z',
  'jangmo-o': 'Jangmo-o', 'hakamo-o': 'Hakamo-o', 'kommo-o': 'Kommo-o',
  'nidoran-f': 'Nidoran♀', 'nidoran-m': 'Nidoran♂',
  'type-null': 'Type: Null', flabebe: 'Flabébé',
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

async function main() {
  const res = await fetch('https://pokeapi.co/api/v2/pokemon-species?limit=2000')
  if (!res.ok) throw new Error(`PokeAPI ${res.status}`)
  const { results } = await res.json() as { results: { name: string; url: string }[] }
  const out: Record<string, string> = {}
  for (const r of results) {
    // .../pokemon-species/6/ → 6
    const id = r.url.match(/\/(\d+)\/?$/)?.[1]
    if (!id) continue
    out[id] = SPECIAL[r.name] ?? r.name.split('-').map(cap).join(' ')
  }
  writeFileSync('lib/data/pokedex-en.json', JSON.stringify(out, null, 1) + '\n')
  console.log(`wrote ${Object.keys(out).length} species to lib/data/pokedex-en.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Run it**

```bash
npx tsx scripts/generate-pokedex-aliases.ts
```

Expected: `wrote 10xx species to lib/data/pokedex-en.json` (~1,025+). Spot-check: `grep '"6":' lib/data/pokedex-en.json` → `"6": "Charizard",`.

- [ ] **Step 4: Write `lib/pokedex.ts`**

```ts
import pokedex from '@/lib/data/pokedex-en.json'

// EN species alias for a TCGdex dexId list. First id wins — TCGdex lists one
// species for regular cards; multi-species cards (tag teams) are rare enough
// that the first name is the useful search hook.
export function aliasForDexIds(dexIds: number[] | null | undefined): string | null {
  const id = dexIds?.[0]
  if (id == null) return null
  return (pokedex as Record<string, string>)[String(id)] ?? null
}
```

- [ ] **Step 5: Run tests**

Run: `npx tsx --test lib/pokedex.test.ts` → PASS. (If the JSON import trips the module resolver, `tsconfig.json` needs `"resolveJsonModule": true` — Next.js defaults have it; only touch tsconfig if the error actually appears.)

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-pokedex-aliases.ts lib/data/pokedex-en.json lib/pokedex.ts lib/pokedex.test.ts
git commit -m "feat: EN species alias table (dexId → name) for CJK card search"
```

---

### Task 4: TCGdex catalogue sweep (CJK card rows)

**Files:**
- Modify: `lib/prices/sync.ts` (export the private `chunked` helper)
- Create: `lib/prices/tcgdex-sweep.ts`, `lib/prices/tcgdex-sweep.test.ts`

**Interfaces:**
- Consumes: `fetchTcgdexSets`, `fetchTcgdexSet` (Task 2); `tcgdexExternalId` (Task 2); `TCGDEX_LANGS`, `NON_EN_LANGUAGES` (Task 1); `AppSettings.enabledLanguages` (Task 1); `chunked` from `@/lib/prices/sync`.
- Produces: `sweepTcgdexCatalogue(settings, dbc?, deps?, onSet?): Promise<TcgdexSweepResult>` with `TcgdexSweepResult = { setsChecked: number; setsImported: number; setsFailed: number; cardsSeen: number; newCards: number }` and `TcgdexSweepDeps = { fetchSets?: typeof fetchTcgdexSets; fetchSet?: typeof fetchTcgdexSet }`.

- [ ] **Step 1: Export `chunked` from `lib/prices/sync.ts`**

Change `function chunked<T>` to `export function chunked<T>` (no other changes in this step).

- [ ] **Step 2: Write failing sweep tests**

`lib/prices/tcgdex-sweep.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import type { TcgdexSetBrief, TcgdexSetDetail } from '@/lib/apis/tcgdex'

const jaSets: TcgdexSetBrief[] = [{ id: 'SV4a', name: 'レイジングサーフ', cardCount: { total: 2, official: 2 } }]
const jaSetDetail: TcgdexSetDetail = {
  id: 'SV4a', name: 'レイジングサーフ', serie: { id: 'SV', name: 'スカーレット&バイオレット' },
  cards: [
    { id: 'SV4a-006', localId: '006', name: 'ポポッコ', image: 'https://assets.tcgdex.net/ja/SV/SV4a/006' },
    { id: 'SV4a-205', localId: '205', name: 'オリーヴァ' },
  ],
}
const deps = {
  fetchSets: async (lang: string) => (lang === 'ja' ? jaSets : []),
  fetchSet: async (_lang: string, id: string) => (id === 'SV4a' ? jaSetDetail : null),
}
const settings = { ...DEFAULT_SETTINGS, enabledLanguages: ['EN' as const, 'JA' as const] }

test('imports enabled CJK languages only, with qualified ids and localized fields', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue(settings, db, deps)
  assert.equal(r.setsImported, 1)
  assert.equal(r.newCards, 2)

  const [row] = await db.select().from(cards).where(eq(cards.externalId, 'tcgdex:ja:SV4a-006'))
  assert.equal(row.name, 'ポポッコ')
  assert.equal(row.game, 'pokemon')
  assert.equal(row.language, 'JA')
  assert.equal(row.setName, 'レイジングサーフ')
  assert.equal(row.setNumber, '006')
  assert.equal(row.series, 'スカーレット&バイオレット')
  assert.equal(row.imageUrl, 'https://assets.tcgdex.net/ja/SV/SV4a/006/low.webp')
  assert.equal(row.imageUrlLarge, 'https://assets.tcgdex.net/ja/SV/SV4a/006/high.webp')
  assert.equal(row.aliasName, null) // filled later by the per-card price fetch
})

test('idempotent: complete sets are skipped on the second run', async () => {
  const db = await createTestDb()
  await sweepTcgdexCatalogue(settings, db, deps)
  const again = await sweepTcgdexCatalogue(settings, db, deps)
  assert.equal(again.setsImported, 0)
  assert.equal(again.newCards, 0)
  const all = await db.select().from(cards)
  assert.equal(all.filter(c => c.language === 'JA').length, 2)
})

test('EN-only settings sweep nothing', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue({ ...settings, enabledLanguages: ['EN'] }, db, deps)
  assert.equal(r.setsChecked, 0)
})

test('a failing set is counted and does not abort the sweep', async () => {
  const db = await createTestDb()
  const r = await sweepTcgdexCatalogue(settings, db, {
    ...deps,
    fetchSet: async () => { throw new Error('boom') },
  })
  assert.equal(r.setsFailed, 1)
  assert.equal(r.newCards, 0)
})
```

Run: `npx tsx --test lib/prices/tcgdex-sweep.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `lib/prices/tcgdex-sweep.ts`**

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test lib/prices/tcgdex-sweep.test.ts` → PASS. Then `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/prices/sync.ts lib/prices/tcgdex-sweep.ts lib/prices/tcgdex-sweep.test.ts
git commit -m "feat: TCGdex CJK catalogue sweep gated by enabledLanguages"
```

---

### Task 5: Generalize the per-card price sync (rename + tcgdex dispatch + alias backfill)

**Files:**
- Modify: `lib/prices/sync.ts` (rename `syncCardmarketForCard` → `syncMarketPricesForCard`; rates object; tcgdex branch)
- Modify: `lib/domain/card-search.ts`, `app/api/prices/cardmarket/route.ts`, `scripts/sync-cardmarket.ts` (call sites)
- Modify: `lib/prices/sync.test.ts` (mechanical signature updates + new tests)

**Interfaces:**
- Consumes: `parseExternalId` (Task 2), `fetchTcgdexCard` (Task 2), `aliasForDexIds` (Task 3), `TCGDEX_LANGS` (Task 1).
- Produces: `syncMarketPricesForCard(cardId: number, externalId: string | null, variant: string | null, rates: { eur: number; usd: number }, dbc?: Db, opts?: { interesting?: boolean }): Promise<void>` — replaces `syncCardmarketForCard` everywhere (5 files). `SearchDeps.syncMarketPrices` replaces `SearchDeps.syncCardmarket` in `lib/domain/card-search.ts`.

- [ ] **Step 1: Write failing tests for the tcgdex branch**

`lib/prices/sync.test.ts` stubs `globalThis.fetch` via its `stubFetch(opts)` helper, which routes TCGdex URLs by the last path segment and currently only answers with `{ pricing: { cardmarket: … } }`. Extend the helper with a full-card option, checked **before** the existing `cardmarket` lookup in the `api.tcgdex.net` branch:

```ts
  // in stubFetch's opts type:
  tcgdexCards?: Record<string, { dexId?: number[]; pricing?: { cardmarket?: unknown; tcgplayer?: unknown } } | 'fail' | 'missing'>
```

```ts
    if (url.includes('api.tcgdex.net')) {
      const id = url.split('/').pop()!
      const tc = opts.tcgdexCards?.[id]
      if (tc === 'missing') return new Response('not found', { status: 404 })
      if (tc === 'fail') return new Response('boom', { status: 500 })
      if (tc) return Response.json(tc)
      // …existing cardmarket lookup unchanged…
```

Add a JA-row helper next to the file's other helpers (`schema` is already imported):

```ts
async function insertJaCard(dbc: Db, aliasName: string | null = null): Promise<number> {
  const [c] = await dbc.insert(schema.cards).values({
    name: 'リザードン', aliasName, game: 'pokemon', language: 'JA',
    setName: 'テスト', setNumber: '006', externalId: 'tcgdex:ja:TEST-006',
  }).returning()
  return c.id
}
```

Then the tests (dex 6 = Charizard, dex 25 = Pikachu — both stable):

```ts
test('tcgdex ids fetch per-language, write both column families, and backfill alias', async () => {
  const id = await insertJaCard(db)
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: {
    cardmarket: { trend: 4, low: 3, avg: 3.5 },
    tcgplayer: { holofoil: { marketPrice: 5, lowPrice: 4, midPrice: 4.5, highPrice: 9 } },
  } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)

  const [pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.equal(pc.cardmarketTrend, Math.round(4 * 0.85 * 100))
  assert.equal(pc.tcgplayerMarket, Math.round(5 * 0.8 * 100))
  assert.ok(pc.cardmarketSyncedAt)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Charizard')
})

test('tcgdex card with null pricing blocks stamps the check and still backfills alias', async () => {
  const id = await insertJaCard(db)
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [25], pricing: { cardmarket: null, tcgplayer: null } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)

  const [pc] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, id))
  assert.ok(pc.cardmarketSyncedAt)   // checked — rotation moves on
  assert.equal(pc.cardmarketTrend, null)
  assert.equal(pc.tcgplayerMarket, null)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Pikachu')
})

test('alias backfill never overwrites an existing aliasName', async () => {
  const id = await insertJaCard(db, 'Custom')
  stubFetch({ tcgdexCards: { 'TEST-006': { dexId: [6], pricing: { cardmarket: null, tcgplayer: null } } } })
  await syncMarketPricesForCard(id, 'tcgdex:ja:TEST-006', null, { eur: 0.85, usd: 0.8 }, db)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id))
  assert.equal(card.aliasName, 'Custom')
})
```

Run: `npx tsx --test lib/prices/sync.test.ts` → FAIL (`syncMarketPricesForCard` not exported).

- [ ] **Step 2: Rename + widen the signature in `lib/prices/sync.ts`**

Rename the function and change `eurRate: number` to `rates: { eur: number; usd: number }`:

```ts
// Per-card marketplace sync. EN rows (bare pokemontcg.io ids) fetch the
// TCGdex/en Cardmarket block exactly as before; tcgdex:<lang>:<id> rows fetch
// the per-language card, write BOTH column families (Cardmarket EUR +
// TCGplayer USD — TCGdex embeds both), and backfill cards.aliasName from
// dexId while the response is in hand. Propagates TcgdexError on transient
// failures (so sweeps count them as failed and retry another night).
export async function syncMarketPricesForCard(
  cardId: number, externalId: string | null, variant: string | null,
  rates: { eur: number; usd: number }, dbc: Db = db,
  opts: { interesting?: boolean } = {},
): Promise<void> {
  if (!externalId) return
  const parsed = parseExternalId(externalId)
  // 'EN' guard: a hypothetical tcgdex:en:… id has no TCGDEX_LANGS entry —
  // EN always takes the pokemontcg.io path below.
  if (parsed.source === 'tcgdex' && parsed.language !== 'EN') {
    return syncTcgdexCard(cardId, parsed.language, parsed.id, rates, dbc, opts)
  }
  // — existing body follows, with `eurRate` replaced by `rates.eur` —
```

Imports to add at the top of the file:

```ts
import { parseExternalId } from '@/lib/sources/external-id'
import { fetchTcgdexCard } from '@/lib/apis/tcgdex'
import { aliasForDexIds } from '@/lib/pokedex'
import { TCGDEX_LANGS, type Language } from '@/lib/games'
```

(also extend the existing drizzle-orm import with `and`/`isNull` if not present — check the file's line 1.)

- [ ] **Step 3: Add the tcgdex branch (new private function in the same file)**

```ts
async function syncTcgdexCard(
  cardId: number, language: Exclude<Language, 'EN'>, rawId: string,
  rates: { eur: number; usd: number }, dbc: Db,
  opts: { interesting?: boolean },
): Promise<void> {
  const card = await fetchTcgdexCard(TCGDEX_LANGS[language], rawId)
  const syncedAt = new Date().toISOString()

  // Alias backfill piggybacks on the fetch — fills blanks only.
  const alias = aliasForDexIds(card?.dexId)
  if (alias) {
    await dbc.update(cards).set({ aliasName: alias })
      .where(and(eq(cards.id, cardId), isNull(cards.aliasName)))
  }

  const cm = card?.cardmarket ?? null
  const tp = card?.tcgplayer ?? null
  if (!cm && !tp) {
    // Answered with no marketplace data (the JP-exclusive norm) or unknown id:
    // record the check so the rotation moves on, keep any cached values.
    await dbc.insert(priceCache).values({ cardId, cardmarketSyncedAt: syncedAt })
      .onConflictDoUpdate({
        target: priceCache.cardId,
        set: { cardmarketSyncedAt: sql`excluded.cardmarket_synced_at` },
      })
    return
  }

  const trend = eurToGbp(cm?.trend ?? null, rates.eur)
  const values = {
    cardId,
    cardmarketTrend: trend,
    cardmarketLow: eurToGbp(cm?.low ?? null, rates.eur),
    cardmarketAvg: eurToGbp(cm?.avg ?? null, rates.eur),
    cardmarketSyncedAt: syncedAt,
    tcgplayerMarket: usdToGbp(tp?.market ?? null, rates.usd),
    tcgplayerLow: usdToGbp(tp?.low ?? null, rates.usd),
    tcgplayerMid: usdToGbp(tp?.mid ?? null, rates.usd),
    tcgplayerHigh: usdToGbp(tp?.high ?? null, rates.usd),
    lastSyncedAt: syncedAt,
  }
  // Only overwrite the column family the response actually carried — a
  // present cardmarket block with an absent tcgplayer block must not null
  // out previously cached TCGplayer values (and vice versa).
  const set: Record<string, unknown> = { cardmarketSyncedAt: sql`excluded.cardmarket_synced_at` }
  if (cm) {
    set.cardmarketTrend = sql`excluded.cardmarket_trend`
    set.cardmarketLow = sql`excluded.cardmarket_low`
    set.cardmarketAvg = sql`excluded.cardmarket_avg`
  }
  if (tp) {
    set.tcgplayerMarket = sql`excluded.tcgplayer_market`
    set.tcgplayerLow = sql`excluded.tcgplayer_low`
    set.tcgplayerMid = sql`excluded.tcgplayer_mid`
    set.tcgplayerHigh = sql`excluded.tcgplayer_high`
    set.lastSyncedAt = sql`excluded.last_synced_at`
  }
  await dbc.insert(priceCache).values(values)
    .onConflictDoUpdate({ target: priceCache.cardId, set })

  if (opts.interesting ?? await isInteresting(dbc, cardId)) {
    await dbc.insert(priceHistory).values({
      cardId, cardmarketTrend: trend, tcgplayerMarket: values.tcgplayerMarket, recordedOn: today(),
    }).onConflictDoUpdate({
      target: [priceHistory.cardId, priceHistory.recordedOn],
      set: { cardmarketTrend: sql`excluded.cardmarket_trend`, tcgplayerMarket: sql`excluded.tcgplayer_market` },
    })
  }
}
```

- [ ] **Step 4: Update every call site (mechanical rename + rates object)**

- `lib/prices/sync.ts` — `syncInStockCardmarket` and `syncStaleCardmarket`: `syncMarketPricesForCard(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, dbc, { interesting: ... })`. `refreshStaleCardmarket`: `opts.sync?: typeof syncMarketPricesForCard`, call `sync(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, dbc)`.
- `lib/domain/card-search.ts` — import rename; `SearchDeps.syncCardmarket` → `syncMarketPrices` (update both uses and `pricesForFresh`'s param type); in `insertCardSafely`, the fire-and-forget becomes `void syncMarketPrices(card.id, card.externalId, card.variant, { eur: eurRate, usd: rate }).catch(() => {})`.
- `app/api/prices/cardmarket/route.ts` — `await syncMarketPricesForCard(card.id, card.externalId, card.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp }, db)`.
- `scripts/sync-cardmarket.ts` — `await syncMarketPricesForCard(c.id, c.externalId, c.variant, { eur: settings.eurToGbp, usd: settings.usdToGbp })`.
- `lib/prices/sync.test.ts` — mechanical: every `syncCardmarketForCard(…, 0.85, …)` → `syncMarketPricesForCard(…, { eur: 0.85, usd: 0.79 }, …)`; keep all behavioral assertions unchanged.

- [ ] **Step 5: Run tests**

Run: `npx tsx --test lib/prices/sync.test.ts lib/domain/card-search.test.ts` → PASS. Then `npm test` → green, and `npm run lint` → clean (catches any missed rename).

- [ ] **Step 6: Commit**

```bash
git add lib/prices/sync.ts lib/prices/sync.test.ts lib/domain/card-search.ts app/api/prices/cardmarket/route.ts scripts/sync-cardmarket.ts
git commit -m "feat: per-card sync dispatches on external-id source; TCGdex rows get dual-block prices + alias backfill"
```

---

### Task 6: Nightly orchestration + import script

**Files:**
- Modify: `lib/prices/run-sync.ts`
- Modify: `scripts/import-catalogue.ts`
- Test: extend `lib/prices/tcgdex-sweep.test.ts` is NOT needed — `run-sync` has no test file today; add `lib/prices/run-sync.test.ts`

**Interfaces:**
- Consumes: `sweepTcgdexCatalogue` (Task 4).
- Produces: `runFullPriceSync` result gains `tcgdexSweep: TcgdexSweepResult`.

- [ ] **Step 1: Write failing test**

`lib/prices/run-sync.test.ts` — `runFullPriceSync` takes no deps today; rather than mock three network sweeps, give it an injectable deps object (same pattern as `SearchDeps`):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from '@/lib/db/test-helpers'
import { runFullPriceSync } from '@/lib/prices/run-sync'

test('nightly sync runs EN sweep, in-stock, rotation, tcgdex sweep, prune — and reports each', async () => {
  const db = await createTestDb()
  const calls: string[] = []
  const result = await runFullPriceSync(db, {
    sweepTcgplayer: async () => { calls.push('en'); return { pagesFetched: 0, pagesFailed: 0, cardsSeen: 0, newCards: 0, pricesUpdated: 0 } },
    syncInStock: async () => { calls.push('instock'); return { synced: 0, failed: 0 } },
    syncStale: async () => { calls.push('rotation'); return { synced: 0, failed: 0, remaining: 0 } },
    sweepTcgdex: async () => { calls.push('tcgdex'); return { setsChecked: 0, setsImported: 0, setsFailed: 0, cardsSeen: 0, newCards: 0 } },
    prune: async () => { calls.push('prune') },
  })
  assert.deepEqual(calls, ['en', 'tcgdex', 'instock', 'rotation', 'prune'])
  assert.ok(result.tcgdexSweep)
})
```

Run: `npx tsx --test lib/prices/run-sync.test.ts` → FAIL.

- [ ] **Step 2: Extend `lib/prices/run-sync.ts`**

```ts
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import type { Db } from '@/lib/db'

interface RunSyncDeps {
  sweepTcgplayer?: typeof sweepTcgplayerCatalogue
  sweepTcgdex?: typeof sweepTcgdexCatalogue
  syncInStock?: typeof syncInStockCardmarket
  syncStale?: typeof syncStaleCardmarket
  prune?: typeof pruneOldHistory
}

// One tenant's full nightly refresh. EN catalogue sweep, then the TCGdex CJK
// catalogue sweep (new sets only after the initial import — cheap), then
// per-card in-stock sync, then the bounded stalest-first rotation (which now
// also covers CJK rows and backfills aliases), then history retention.
// Rotation runs after the in-stock sync so freshly synced stock sorts to the
// back of the rotation queue instead of being fetched twice.
export async function runFullPriceSync(db: Db, deps: RunSyncDeps = {}) {
  const settings = await getSettings(db)
  const sweep = await (deps.sweepTcgplayer ?? sweepTcgplayerCatalogue)(settings, {}, db)
  const tcgdexSweep = await (deps.sweepTcgdex ?? sweepTcgdexCatalogue)(settings, db)
  const cardmarket = await (deps.syncInStock ?? syncInStockCardmarket)(settings, db)
  const cardmarketRotation = await (deps.syncStale ?? syncStaleCardmarket)(settings, {}, db)
  await (deps.prune ?? pruneOldHistory)(db)
  return { sweep, tcgdexSweep, cardmarket, cardmarketRotation }
}
```

- [ ] **Step 3: Run tests** → PASS (`npx tsx --test lib/prices/run-sync.test.ts`, then `npm test`).

- [ ] **Step 4: Extend `scripts/import-catalogue.ts`**

After the EN sweep block, add the CJK sweep + an optional full price/alias pass:

```ts
import { sweepTcgdexCatalogue } from '../lib/prices/tcgdex-sweep'
import { syncStaleCardmarket } from '../lib/prices/sync'
```

```ts
  const cjk = await sweepTcgdexCatalogue(settings, undefined, {}, (setId, r) => {
    console.log(`tcgdex ${setId}: ${r.cardsSeen} cards seen, ${r.newCards} new, ${r.setsFailed} failed sets`)
  })
  console.log('TCGdex sweep done:', cjk)

  // --full-prices: run the per-card rotation to completion now (prices where
  // TCGdex has them + alias_name backfill) instead of trickling ~2,000/night.
  // A full CJK catalogue is tens of thousands of per-card fetches — expect
  // this to run for a while; it is safe to interrupt and re-run.
  if (process.argv.includes('--full-prices')) {
    let pass = 1
    for (;;) {
      const r = await syncStaleCardmarket(settings, { limit: 5000, timeBudgetMs: 10 * 60_000 })
      console.log(`rotation pass ${pass++}: synced ${r.synced}, failed ${r.failed}, remaining ${r.remaining}`)
      if (r.remaining <= 0 || r.synced + r.failed === 0) break
    }
  }
  if (result.pagesFailed > 0 || cjk.setsFailed > 0) process.exitCode = 1
```

(replace the script's existing `if (result.pagesFailed > 0) process.exitCode = 1` line with the combined check.)

- [ ] **Step 5: Lint + full tests**

Run: `npm run lint && npm test` → clean/green. (The script has no automated test — the cron path is covered by Step 1's test; the script is the same calls with logging.)

- [ ] **Step 6: Commit**

```bash
git add lib/prices/run-sync.ts lib/prices/run-sync.test.ts scripts/import-catalogue.ts
git commit -m "feat: nightly sync + import script sweep TCGdex CJK catalogues (--full-prices for day-one backfill)"
```

---

### Task 7: Search — alias matching, language/game filters, CSV game/language scoping

**Files:**
- Modify: `lib/domain/card-search.ts`, `lib/domain/card-search.test.ts`
- Modify: `app/api/cards/search/route.ts`
- Modify: `app/api/inventory/import/route.ts`
- Test: extend `lib/domain/card-search.test.ts`; CSV behavior is covered by a route-level domain test only if one already exists — otherwise the manual-verify step below.

**Interfaces:**
- Consumes: `cards.aliasName` (Task 1), `isLanguage`, `GAME_IDS`, `Game`, `Language` (Task 1).
- Produces: `searchCards(q, dbc?, deps?, filters?: { game?: Game; language?: Language })`; search API accepts optional `game`/`language` query params.

- [ ] **Step 1: Write failing search tests**

Add to `lib/domain/card-search.test.ts` (reuse the file's existing seeding style; the key rows: an EN Pikachu and a JA row `{ name: 'ピカチュウ', aliasName: 'Pikachu', game: 'pokemon', language: 'JA', setName: 'テスト', setNumber: '025', externalId: 'tcgdex:ja:TEST-025' }`):

```ts
test('alias matches: searching the EN species name finds the JA printing', async () => {
  const { cards: found } = await searchCards('Pikachu', db, noLiveDeps)
  const names = found.map(c => c.name)
  assert.ok(names.includes('ピカチュウ'))
})

test('set-number search finds CJK rows', async () => {
  const { cards: found } = await searchCards('025', db, noLiveDeps)
  assert.ok(found.some(c => c.language === 'JA'))
})

test('language filter narrows results', async () => {
  const ja = await searchCards('Pikachu', db, noLiveDeps, { language: 'JA' })
  assert.ok(ja.cards.length > 0)
  assert.ok(ja.cards.every(c => c.language === 'JA'))
  const en = await searchCards('Pikachu', db, noLiveDeps, { language: 'EN' })
  assert.ok(en.cards.every(c => c.language === 'EN'))
})

test('fuzzy suggestions score alias names too', async () => {
  const { cards: found, fuzzy } = await searchCards('Pikchu', db, noLiveDeps)
  assert.equal(fuzzy, true)
  assert.ok(found.some(c => c.name === 'ピカチュウ'))
})
```

(`noLiveDeps` = whatever the file already uses to stub `fetchLive` to return `[]`.)

Run: `npx tsx --test lib/domain/card-search.test.ts` → FAIL.

- [ ] **Step 2: Implement in `lib/domain/card-search.ts`**

Add imports: `and` from drizzle-orm; `type Game, type Language` from `@/lib/games`.

```ts
export interface CardSearchFilters {
  game?: Game
  language?: Language
}
```

`searchCards` gains a 4th param `filters: CardSearchFilters = {}` and builds the filter fragment once:

```ts
  const scope = [
    ...(filters.game ? [eq(cards.game, filters.game)] : []),
    ...(filters.language ? [eq(cards.language, filters.language)] : []),
  ]
```

LIKE stage — add the alias predicate and the scope:

```ts
  const likeMatches = await dbc.select().from(cards)
    .where(and(
      or(like(cards.name, `%${q}%`), like(cards.aliasName, `%${q}%`), like(cards.setNumber, `%${q}%`)),
      ...scope,
    ))
```

Fuzzy stage — replace `searchFuzzy` wholesale (scores alias names too, carries the scope):

```ts
// Score every distinct catalogue name (and EN alias, for CJK rows) against
// the query in memory, then pull all printings of the closest few names.
async function searchFuzzy(q: string, dbc: Db, scope: SQL[]): Promise<Card[]> {
  const names = await dbc.selectDistinct({ name: cards.name, aliasName: cards.aliasName })
    .from(cards)
    .where(scope.length ? and(...scope) : undefined)
  const scores = new Map<string, number>()
  for (const { name, aliasName } of names) {
    const score = Math.max(similarity(q, name), aliasName ? similarity(q, aliasName) : 0)
    if (score >= FUZZY_THRESHOLD) scores.set(name, Math.max(score, scores.get(name) ?? 0))
  }
  if (scores.size === 0) return []

  const topNames = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FUZZY_MAX_NAMES)
    .map(([name]) => name)

  const rows = await dbc.select().from(cards)
    .where(and(inArray(cards.name, topNames), ...scope))
    .limit(CARD_SEARCH_LIMIT)
  return rows.sort((a, b) =>
    (scores.get(b.name)! - scores.get(a.name)!) || a.name.localeCompare(b.name) || a.setName.localeCompare(b.setName))
}
```

with `import type { SQL } from 'drizzle-orm'` added, and the call site updated to `searchFuzzy(q, dbc, scope)`.

Live-API stage — pokemontcg.io is EN-only: skip it when `filters.language` is set to a non-EN value (return the empty result instead of inserting EN cards into a JA-filtered search):

```ts
  if (filters.language && filters.language !== 'EN') {
    return { cards: [], prices: {}, fuzzy: false, unavailable: false }
  }
```

- [ ] **Step 3: Wire the route (`app/api/cards/search/route.ts`)**

```ts
import { isLanguage, GAME_IDS, type Game } from '@/lib/games'
```

```ts
  const langParam = req.nextUrl.searchParams.get('language')
  const gameParam = req.nextUrl.searchParams.get('game')
  const filters = {
    ...(langParam && isLanguage(langParam) ? { language: langParam } : {}),
    ...(gameParam && (GAME_IDS as readonly string[]).includes(gameParam) ? { game: gameParam as Game } : {}),
  }
  return NextResponse.json(await searchCards(q, db, {}, filters))
```

(`searchCards`'s third param is `deps` — pass `{}`.)

- [ ] **Step 4: CSV import scoping (`app/api/inventory/import/route.ts`)**

Add imports: `isLanguage, GAME_IDS, type Game, type Language` from `@/lib/games`.

In the row loop, after `setNumber`:

```ts
      const gameRaw = col(r, 'game')?.toLowerCase()
      const game = (gameRaw || 'pokemon') as Game
      if (!(GAME_IDS as readonly string[]).includes(game)) throw new Error(`bad game "${gameRaw}"`)
      const languageRaw = col(r, 'language')?.toUpperCase()
      const language = (languageRaw || 'EN') as Language
      if (!isLanguage(language)) throw new Error(`bad language "${languageRaw}"`)
```

Change the name/setNumber match to be identity-scoped, and stamp created rows:

```ts
        if (!cardId && name && setNumber) {
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
```

- [ ] **Step 5: Run tests**

Run: `npx tsx --test lib/domain/card-search.test.ts` → PASS. `npm test` → green (an existing CSV-import test may pin the old match — update it to pass game/language defaults if it breaks; defaulted columns must keep every pre-existing CSV working).

- [ ] **Step 6: Commit**

```bash
git add lib/domain/card-search.ts lib/domain/card-search.test.ts app/api/cards/search/route.ts app/api/inventory/import/route.ts
git commit -m "feat: search matches alias names + optional game/language filters; CSV import is identity-scoped"
```

---

### Task 8: Settings API + settings UI for enabled languages

**Files:**
- Modify: `app/api/settings/route.ts`
- Modify: `components/settings/SettingsForm.tsx`

**Interfaces:**
- Consumes: `AppSettings.enabledLanguages` (Task 1), `LANGUAGES`, `LANGUAGE_LABELS`, `isLanguage`, `type Language` (Task 1).
- Produces: `PATCH /api/settings` accepts `enabledLanguages: string[]`.

- [ ] **Step 1: Route validation (`app/api/settings/route.ts`)**

The PATCH handler validates field-by-field (no zod in this route — match its existing style). Add, before the final `updateSettings` call:

```ts
  if (body.enabledLanguages != null) {
    if (!Array.isArray(body.enabledLanguages) || !body.enabledLanguages.every(isLanguage)) {
      return NextResponse.json({ error: 'Invalid enabledLanguages' }, { status: 400 })
    }
    // 'EN' is always on — the EN catalogue is the app's baseline.
    patch.enabledLanguages = [...new Set<Language>(['EN', ...body.enabledLanguages])]
  }
```

with `import { isLanguage, type Language } from '@/lib/games'`.

- [ ] **Step 2: Settings form**

In `components/settings/SettingsForm.tsx`, following the form's existing state/save pattern (`primaryPriceSource` is the model — a `useState` seeded from `current`, included in the save body):

```tsx
import { LANGUAGES, LANGUAGE_LABELS, type Language } from '@/lib/games'
```

```tsx
  const [enabledLanguages, setEnabledLanguages] = useState<Language[]>(current.enabledLanguages)
```

Add `enabledLanguages,` to the JSON body of the form's save handler (next to `primaryPriceSource`).

Add a field group after the primary-price-source toggle, using the same section/label markup that file uses around its other fields:

```tsx
        <div>
          <p className="text-sm font-medium mb-2">Card languages</p>
          <p className="text-xs text-muted-foreground mb-2">
            Languages the catalogue imports and search offers. English is always on.
            Most non-English printings have no market price — set selling prices at
            intake or on the till.
          </p>
          <div className="flex gap-2 flex-wrap">
            {LANGUAGES.map(lang => {
              const on = enabledLanguages.includes(lang)
              return (
                <button
                  key={lang}
                  type="button"
                  disabled={lang === 'EN'}
                  aria-pressed={on}
                  onClick={() => setEnabledLanguages(prev =>
                    on ? prev.filter(l => l !== lang) : [...prev, lang])}
                  className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-70 ${
                    on ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted border-border'
                  }`}
                >
                  {LANGUAGE_LABELS[lang]}
                </button>
              )
            })}
          </div>
        </div>
```

- [ ] **Step 3: Verify in the browser**

Start the dev server (preview tooling), open Settings as admin, toggle Japanese on, save, reload — Japanese stays on; `GET /api/settings` returns `enabledLanguages: ["EN","JA"]`. EN button is disabled-on.

- [ ] **Step 4: Run `npm run lint && npm test`** → clean/green.

- [ ] **Step 5: Commit**

```bash
git add app/api/settings/route.ts components/settings/SettingsForm.tsx
git commit -m "feat: enabledLanguages setting — API validation + settings UI toggles"
```

---

### Task 9: UI — language badges, intake nudge, till quick-set, manual buy offers

**Files:**
- Modify: `components/pos/CardResult.tsx` (badge + quick-set)
- Modify: `components/buylist/BuyCard.tsx` (badge + manual offers)
- Modify: `components/inventory/AddItemForm.tsx` (badge in results + no-market callout)
- Modify: `components/catalogue/CatalogueBrowser.tsx` (badge)

All four use the shared snippet — language badge, rendered next to each card's `setName · #setNumber` line (every file already imports `Badge`):

```tsx
{card.language !== 'EN' && (
  <Badge variant="outline">{LANGUAGE_LABELS[card.language as Language] ?? card.language}</Badge>
)}
```

with `import { LANGUAGE_LABELS, type Language } from '@/lib/games'` (dependency-free, client-safe).

**Interfaces:**
- Consumes: `PATCH /api/inventory/[id]` accepts `{ sellPriceOverride }` for staff sessions (already true — verified); `parsePounds`, `pickMarketPrice` from `@/lib/pricing`; `useSettings()` from `@/components/shared/SettingsProvider`.

- [ ] **Step 1: Badges (all four files)**

Insert the snippet above beside the set line in: `CardResult.tsx` (inside the `<p className="text-sm text-muted-foreground">` block's parent, directly under that `<p>`), `BuyCard.tsx` (same position), `AddItemForm.tsx` (both the search-result rows and the selected-card header), `CatalogueBrowser.tsx` (its card tile meta line). Where the anchor differs from this description, the rule is: **wherever `setName` and `setNumber` render for a card, the badge renders too.**

- [ ] **Step 2: Intake nudge (`AddItemForm.tsx`)**

Add imports: `pickMarketPrice` to the existing `@/lib/pricing` import; `import { useSettings } from '@/components/shared/SettingsProvider'`; `import type { PriceCache } from '@/lib/db/schema'` (type-only — the client-bundle rule allows it).

Add state + capture (the search response already carries prices; the form currently discards them):

```tsx
  const [prices, setPrices] = useState<Record<number, PriceCache>>({})
  const { primaryPriceSource } = useSettings()
```

In `search()`, after `setResults(data.cards ?? [])`: `setPrices(data.prices ?? {})`.

In the selected-card form, directly above the sell-override input:

```tsx
          {selected && pickMarketPrice(prices[selected.id], primaryPriceSource) == null && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <span className="font-medium">No market data for this card.</span> Set your
              selling price below — without one the POS blocks the sale until a price is
              set at the till.
            </div>
          )}
```

- [ ] **Step 3: Till quick-set (`CardResult.tsx`)**

Add imports: `parsePounds` to the `@/lib/pricing` import; `import { toast } from 'sonner'`.

Add state inside the component:

```tsx
  const [priceDraft, setPriceDraft] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
```

Add the handler:

```tsx
  // No market price and no override: staff types a price at the till; it
  // persists as the item's override (the price charged is snapshotted on the
  // sale line as usual), then a refresh re-derives the sell price server-side.
  async function quickSetPrice() {
    if (!selected) return
    const pence = parsePounds(priceDraft)
    if (pence <= 0) return
    setSavingPrice(true)
    try {
      const res = await fetch(`/api/inventory/${selected.itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellPriceOverride: pence }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not set price')
        return
      }
      toast.success(`Price set — ${formatGBP(pence)}`)
      setPriceDraft('')
      onRefreshPrice()
    } finally {
      setSavingPrice(false)
    }
  }
```

Replace the existing footer block (`{selected && ( <div className="flex items-center gap-3 pt-1 border-t"> … )}`) with a no-price branch first:

```tsx
            {selected && sellPrice == null ? (
              <div className="flex items-center gap-3 pt-1 border-t">
                <span className="text-sm text-muted-foreground">No price — set one to sell</span>
                <div className="ml-auto flex items-center gap-2">
                  <input
                    value={priceDraft}
                    onChange={e => setPriceDraft(e.target.value)}
                    inputMode="decimal"
                    placeholder="£0.00"
                    aria-label="Set selling price in pounds"
                    className="w-24 h-9 rounded-md border border-input bg-background px-2 text-right text-sm"
                  />
                  <Button disabled={savingPrice || parsePounds(priceDraft) <= 0} onClick={quickSetPrice}>
                    Set price
                  </Button>
                </div>
              </div>
            ) : selected && (
              /* existing price/qty/Add-to-Cart footer, unchanged */
            )}
```

- [ ] **Step 4: Manual buy offers (`BuyCard.tsx`)**

Add `parsePounds` to the `@/lib/pricing` import. Add state:

```tsx
  const [manualCash, setManualCash] = useState('')
  const [manualCredit, setManualCredit] = useState('')
```

In the footer (the `Quantity + Add` block), before the Add button's container, render inputs when there is no market anchor:

```tsx
            {market == null && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Manual offer:</span>
                <input value={manualCash} onChange={e => setManualCash(e.target.value)} inputMode="decimal"
                  placeholder="Cash £" aria-label="Manual cash offer in pounds"
                  className="w-20 h-9 rounded-md border border-input bg-background px-2 text-right text-sm" />
                <input value={manualCredit} onChange={e => setManualCredit(e.target.value)} inputMode="decimal"
                  placeholder="Credit £" aria-label="Manual credit offer in pounds"
                  className="w-20 h-9 rounded-md border border-input bg-background px-2 text-right text-sm" />
              </div>
            )}
```

Change the Add button so a manual offer unblocks it — the buy line carries the typed offers, and `marketAtBuy` correctly stays null server-side:

```tsx
            <Button
              disabled={market == null && (parsePounds(manualCash) <= 0 || parsePounds(manualCredit) <= 0)}
              onClick={() => onAdd({
                cardId: card.id, condition, quantity: qty,
                payPriceCash: market != null ? cashOffer : parsePounds(manualCash),
                payPriceCredit: market != null ? creditOffer : parsePounds(manualCredit),
              })}
            >
              Add to buy
            </Button>
```

Also update the existing `No price data` destructive badge's text to `No market data — manual offer` so the banner names the workflow.

- [ ] **Step 5: Verify in the browser**

Dev server: seed or add a JA card without prices (Task 8's settings toggle + a quick `/inventory/add` entry, or the e2e seed from Task 10). POS: search finds it with a `Japanese` badge; footer shows the quick-set input; setting `7.50` toasts, refreshes, and the normal Add-to-Cart footer appears at £7.50. Buylist: the same card shows manual cash/credit inputs and Add enables once both are filled. Inventory add: selecting it shows the amber no-market callout.

- [ ] **Step 6: Run `npm run lint && npm test`** → clean/green.

- [ ] **Step 7: Commit**

```bash
git add components/pos/CardResult.tsx components/buylist/BuyCard.tsx components/inventory/AddItemForm.tsx components/catalogue/CatalogueBrowser.tsx
git commit -m "feat: language badges + no-price workflow (intake callout, till quick-set, manual buy offers)"
```

---

### Task 10: E2E — sell a JA card with no market price via till quick-set

**Files:**
- Modify: `tests/e2e/seed.ts`
- Create: `tests/e2e/cjk-quickset.spec.ts`

**Interfaces:**
- Consumes: seeded login flow from `tests/e2e/checkout.spec.ts` (owner unlock → PIN pad); quick-set UI (Task 9).

- [ ] **Step 1: Extend the seed**

In `tests/e2e/seed.ts`, after the existing card+item inserts, add a JA card with stock and **no price_cache row and no override**:

```ts
  const [jaCard] = await db.insert(schema.cards).values({
    name: 'ピカチュウ', aliasName: 'Pikachu', game: 'pokemon', language: 'JA',
    setName: 'テストセット', setNumber: '099', externalId: 'tcgdex:ja:TEST-099',
  }).returning()
  await db.insert(schema.inventoryItems).values({
    cardId: jaCard.id, condition: 'NM', quantity: 2, costPrice: 100,
    qrCode: 'e2e-ja-quickset',
  })
```

(match the surrounding inserts' exact style/fields — e.g. if they set `location` or use raw SQL, mirror it. Set number `099` is deliberately distinct from any seeded EN card's number so the search in Step 2 can't be satisfied by the wrong row.)

- [ ] **Step 2: Write the spec**

`tests/e2e/cjk-quickset.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// A JA card with no market price: found via its EN species alias, priced at
// the till (quick-set persists the override), then sold for that price.
test('staff can price and sell a no-market-price JA card at the till', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  // Alias search finds the JA printing, flagged with its language badge.
  // The seeded EN 'Pikachu' matches too — every later locator that could
  // exist on both cards is scoped to the JA result container.
  await page.getByPlaceholder(/scan barcode/i).fill('Pikachu')
  await page.getByRole('button', { name: 'Search' }).click()
  const jaCard = page.locator('div.border.rounded-xl', { hasText: 'ピカチュウ' })
  await expect(jaCard).toBeVisible()
  await expect(jaCard.getByText('Japanese')).toBeVisible()

  // No price → quick-set at the till (only the JA card renders this UI)
  await expect(jaCard.getByText(/no price — set one to sell/i)).toBeVisible()
  await jaCard.getByLabel('Set selling price in pounds').fill('7.50')
  await jaCard.getByRole('button', { name: 'Set price' }).click()

  // Refresh re-derives the sell price from the persisted override
  await expect(jaCard.getByText('£7.50')).toBeVisible()
  await jaCard.getByRole('button', { name: 'Add to Cart' }).click()

  // Cash checkout, £10 tendered against £7.50 → £2.50 change
  await page.getByRole('button', { name: 'Checkout' }).click()
  await page.getByLabel(/cash received/i).fill('10.00')
  await expect(page.getByText('Change')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm £7.50' }).click()
  await expect(page.getByText(/Sale complete.*Change £2\.50/)).toBeVisible()

  // The database agrees: 750p cash sale, and the override persisted on the item
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const sales = await client.execute(`SELECT total FROM sales ORDER BY id DESC LIMIT 1`)
    expect(Number(sales.rows[0].total)).toBe(750)
    const item = await client.execute(
      `SELECT sell_price_override, quantity FROM inventory_items WHERE qr_code = 'e2e-ja-quickset'`)
    expect(Number(item.rows[0].sell_price_override)).toBe(750)
    expect(Number(item.rows[0].quantity)).toBe(1)
  } finally {
    client.close()
  }
})
```

(`div.border.rounded-xl` matches `CardResult`'s root container class; the assertions mirror `checkout.spec.ts`'s post-confirm pattern — `Sale complete.*Change` text plus direct DB checks via `createClient`.)

- [ ] **Step 3: Run e2e**

Run: `npm run test:e2e`
Expected: all specs pass, including `cjk-quickset`. (Remember the env gotchas: runs with `NODE_ENV=test` + `.env.test`; `$` in env values must be escaped.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/seed.ts tests/e2e/cjk-quickset.spec.ts
git commit -m "test: e2e — price and sell a no-market-price JA card via till quick-set"
```

---

### Task 11: Full verification + deploy notes

**Files:**
- Modify: `docs/runbooks/wizard-of-oz-shop-deploy.md` (migration + import notes)

- [ ] **Step 1: Full local verification**

```bash
npm run lint && npm test && npm run test:e2e
```

Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 2: Live-API smoke (one-off, optional but recommended)**

With dev-DB env loaded and Japanese enabled in settings, run the real import once and spot-check:

```bash
npx tsx scripts/import-catalogue.ts
```

Expected: TCGdex set logs appear after the EN sweep; afterwards a JA search in the app returns localized rows. (Full `--full-prices` backfill is the shop-operator's call — it is tens of thousands of fetches.)

- [ ] **Step 3: Runbook notes**

In `docs/runbooks/wizard-of-oz-shop-deploy.md`, add to the deploy checklist section:

```markdown
- Migration 0021 (`alias_name`, `enabled_languages`, game/language index) must be applied
  to the shop DB before deploying this code (additive-only — old code runs fine against
  the new schema, so migrate first, deploy second).
- To enable CJK Pokémon for a shop: Settings → Card languages, then run
  `npx tsx scripts/import-catalogue.ts` once (add `--full-prices` to backfill aliases and
  the few internationally-listed prices immediately; otherwise they trickle in at
  ~2,000 cards/night via the rotation). Most CJK cards have NO market price — staff set
  prices at intake or via the till quick-set.
```

- [ ] **Step 4: Backfill verification (live DBs, user-run)**

Document-only step — the check the spec's §5 requires, run against each live DB after migrating:

```sql
SELECT count(*) FROM cards WHERE game != 'pokemon' OR language != 'EN';
-- expected 0 before the first CJK import; external ids untouched either way
```

- [ ] **Step 5: Commit + hand off**

```bash
git add docs/runbooks/wizard-of-oz-shop-deploy.md
git commit -m "docs: deploy/runbook notes for multi-language phase 1 (migration 0021, CJK import)"
```

Then use superpowers:finishing-a-development-branch (PR from this branch to main; `npm test` + e2e already green).
