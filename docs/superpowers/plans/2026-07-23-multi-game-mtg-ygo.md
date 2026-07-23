# Multi-game phase 2 — Magic + Yu-Gi-Oh! singles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell, buy, stock, and price Magic: The Gathering and Yu-Gi-Oh! singles alongside Pokémon — Scryfall + YGOPRODeck catalogues behind a per-tenant `enabledGames` setting, a game-first search selector on every card-search surface, and multi-game gated to Growth+.

**Architecture:** Activate `cards.game` as a first-class dimension the way phase 1 activated `language`. Two new source adapters normalise their upstream into a shared `NormalizedCard` shape; a source registry maps each `(game, language)` to exactly one catalogue-writing adapter. MTG ships one row per printing **per finish** (nonfoil/foil), YGO one row per **printing** (set × rarity). Prices map onto the existing `price_cache` columns (no schema change there); the market-price picker already falls back cleanly. The 557 MB Scryfall bulk file is used only by the off-cron import script; nightly refresh is a bounded, cursored crawl of Scryfall's paged search API. Spec: `docs/superpowers/specs/2026-07-23-multi-game-mtg-ygo-design.md`.

**Tech Stack:** Next.js App Router, React 19, Drizzle ORM (Turso/SQLite), zod, node:test via tsx, Playwright, `stream-json` (new devDependency, script-only).

## Global Constraints

- All money is **integer pence (GBP)**; convert native→pence only in the sync/upsert layer via `usdToGbp`/`eurToGbp` (`lib/pricing.ts`). No floats/decimal pounds in DB or domain.
- Prices are **server-canonical**; `createSale`'s `NO_PRICE` guard is untouched. Clients never send prices.
- A cached `0` price is **no data, not a price** — `pickMarketSource` already treats it so; normalisers must emit `null` (not `0`) for missing prices.
- Every route: `guarded()` + zod `parseBody()` where a body exists; routes call `const db = await getTenantDb()` and pass it down — **never** import the `db` singleton in a route (`tests/tenancy-guard.test.ts` enforces). Domain/lib functions keep their `dbc: Db = db` default for tests.
- Client components **never value-import** `lib/domain/*` or anything touching `lib/db`; shared constants live in dependency-free modules (`lib/games.ts`, `lib/plan.ts` — the `lib/adjustment-reasons.ts` pattern). `import type` is fine.
- DB `cards.language` values are **uppercase** (`'EN'`); MTG/YGO are `'EN'`-only this phase. DB `cards.game` values are the `GAME_IDS` literals (`'pokemon' | 'mtg' | 'yugioh'`).
- Existing bare external ids (`xy7-54`) are grandfathered pokemontcg.io EN — **never rewritten**. New sources are namespaced (`scryfall:…`, `ygoprodeck:…`).
- `'pokemon'` is always a member of `enabledGames`; `'EN'` is always a member of `enabledLanguages` (phase 1). The baseline game/language can't be disabled.
- Scryfall requires a `User-Agent` **and** `Accept: application/json` header or its CDN returns 403. YGOPRODeck needs a `User-Agent`.
- Tests: colocated `*.test.ts`, `node:test` + `assert/strict`, in-memory DB via `createTestDb()` / `seedBase()` from `@/lib/db/test-helpers`. Run all: `npm test`; single file: `npx tsx --test <path>`. `npm run lint` before declaring a task done.
- UK English in all copy.
- Work on the current branch `multi-game-mtg-ygo` — it already carries the spec and this plan; the PR goes up from it.

---

### Task 1: Foundation — game metadata, `enabledGames` setting, `multiGame` entitlement, migration 0023

**Files:**
- Modify: `lib/games.ts` (GAMES metadata + isGame; extend GAME_IDS)
- Modify: `lib/plan.ts` (`multiGame` entitlement)
- Modify: `lib/plan.test.ts` (exists — extend)
- Modify: `lib/db/schema.ts` (`settings.enabled_games`; new `catalogueSyncState` table)
- Modify: `lib/settings.ts` (parse/serialize/validate `enabledGames`)
- Modify: `lib/settings.test.ts` (exists — extend)
- Modify: `lib/prices/sync.test.ts` (its `SETTINGS` literal gains `enabledGames`)
- Modify: `components/shared/SettingsProvider.tsx` (fallback literal gains `enabledGames`)
- Generate: `lib/db/migrations/0023_*.sql`

**Interfaces:**
- Produces: `GAME_IDS` (now `['pokemon','mtg','yugioh']`), `Game`, `GameMeta`, `GAMES: Record<Game, GameMeta>`, `isGame(x): x is Game` (from `@/lib/games`); `AppSettings.enabledGames: Game[]`; `Entitlements.multiGame: boolean`; `cards`/`price_cache` unchanged; new table `catalogueSyncState` with columns `game` (pk), `cursor`, `updatedAt`.

- [ ] **Step 1: Extend `lib/games.ts` with game metadata**

Replace the `GAME_IDS`/`Game` lines at the top with the metadata block (leave the `LANGUAGES`/`TCGDEX_LANGS` section below untouched):

```ts
export const GAME_IDS = ['pokemon', 'mtg', 'yugioh'] as const
export type Game = (typeof GAME_IDS)[number]

export function isGame(x: unknown): x is Game {
  return typeof x === 'string' && (GAME_IDS as readonly string[]).includes(x)
}
```

Then, **after** the `LANGUAGES` block (so `Language` is defined), add the per-game metadata:

```ts
export interface GameMeta {
  id: Game
  label: string       // full name for settings/labels
  shortLabel: string  // compact name for badges/chips
  hasCatalogue: boolean // false is reserved for phase-3 manual games (Topps/Panini)
  languages: Language[] // languages this game's catalogue is offered in
}

// Metadata for badges, the settings toggle, and the search selector. Keep this
// dependency-free — client components import it. Pokémon carries all five
// languages (phase 1); MTG/YGO are EN-only in phase 2.
export const GAMES: Record<Game, GameMeta> = {
  pokemon: { id: 'pokemon', label: 'Pokémon', shortLabel: 'Pokémon', hasCatalogue: true, languages: [...LANGUAGES] },
  mtg: { id: 'mtg', label: 'Magic: The Gathering', shortLabel: 'Magic', hasCatalogue: true, languages: ['EN'] },
  yugioh: { id: 'yugioh', label: 'Yu-Gi-Oh!', shortLabel: 'Yu-Gi-Oh!', hasCatalogue: true, languages: ['EN'] },
}
```

- [ ] **Step 2: Add the `multiGame` entitlement (write the failing test first)**

Add to `lib/plan.test.ts` (reuse its imports):

```ts
test('multiGame entitlement is off on Starter, on for Growth and Pro', () => {
  assert.equal(PLANS.starter.entitlements.multiGame, false)
  assert.equal(PLANS.growth.entitlements.multiGame, true)
  assert.equal(PLANS.pro.entitlements.multiGame, true)
})

test('entitlement_overrides can force multiGame on for a founding Starter shop', () => {
  assert.equal(entitlementsFor('starter').multiGame, false)
  assert.equal(entitlementsFor('starter', JSON.stringify({ multiGame: true })).multiGame, true)
})
```

Run: `npx tsx --test lib/plan.test.ts` → FAIL (`multiGame` missing).

- [ ] **Step 3: Implement the entitlement**

In `lib/plan.ts`, add `multiGame: boolean` to the `Entitlements` interface (with a one-line comment `// Growth+ (spec 2026-07-23) — a second game`), and set it in each plan:

```ts
starter: { label: 'Starter', pricePence: 3900, entitlements: { staffSeats: 2, listingSync: false, apiAccess: false, multiGame: false } },
growth: { label: 'Growth', pricePence: 7900, entitlements: { staffSeats: 5, listingSync: false, apiAccess: false, multiGame: true } },
pro: { label: 'Pro', pricePence: 14900, entitlements: { staffSeats: null, listingSync: true, apiAccess: true, multiGame: true } },
```

Run: `npx tsx --test lib/plan.test.ts` → PASS.

- [ ] **Step 4: Edit the schema — `enabled_games` column + `catalogue_sync_state` table**

In `lib/db/schema.ts`, in the `settings` table, after the `enabledLanguages` line add:

```ts
  // JSON array of Game ids (lib/games.ts). 'pokemon' is always a member.
  enabledGames: text('enabled_games').notNull().default('["pokemon"]'),
```

At the end of the file (after the last table), add the sync-cursor table:

```ts
// Per-game catalogue sweep progress (operational state, deliberately not in
// `settings`). `cursor` is adapter-defined: the Scryfall paged sweep stores
// the next page number; games swept in one call (YGOPRODeck) never write here.
export const catalogueSyncState = sqliteTable('catalogue_sync_state', {
  game: text('game').primaryKey(),
  cursor: text('cursor'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})
```

- [ ] **Step 5: Generate migration 0023**

```bash
npx drizzle-kit generate --name multi-game-mtg-ygo
```

Expected: `lib/db/migrations/0023_multi-game-mtg-ygo.sql` containing `ALTER TABLE settings ADD enabled_games text DEFAULT '["pokemon"]' NOT NULL;` and `CREATE TABLE catalogue_sync_state (...)`. If the shell has `TURSO_*` vars set, unset them first (migration/deploy gotcha).

- [ ] **Step 6: Write the failing settings test**

Add to `lib/settings.test.ts` (reuse its imports):

```ts
test('enabledGames defaults to pokemon and round-trips, always keeping pokemon', async () => {
  const db = await createTestDb()
  assert.deepEqual((await getSettings(db)).enabledGames, ['pokemon'])

  const updated = await updateSettings({ enabledGames: ['pokemon', 'mtg'] }, db)
  assert.deepEqual(updated.enabledGames, ['pokemon', 'mtg'])
  assert.deepEqual((await getSettings(db)).enabledGames, ['pokemon', 'mtg'])

  // pokemon can never be dropped
  const dropped = await updateSettings({ enabledGames: ['mtg'] }, db)
  assert.ok(dropped.enabledGames.includes('pokemon'))
})

test('malformed enabled_games JSON degrades to [pokemon], never throws', async () => {
  const db = await createTestDb()
  await getSettings(db)
  await db.run(sql`UPDATE settings SET enabled_games = 'not json' WHERE id = 1`)
  assert.deepEqual((await getSettings(db)).enabledGames, ['pokemon'])
})
```

(Add `import { sql } from 'drizzle-orm'` if absent.) Run: `npx tsx --test lib/settings.test.ts` → FAIL (`enabledGames` missing from `AppSettings`).

- [ ] **Step 7: Wire `enabledGames` through settings**

In `lib/settings.ts`:

- Extend the import: `import { type Language, isLanguage, LANGUAGES, type Game, isGame, GAME_IDS } from '@/lib/games'`.
- Add `enabledGames: Game[]` to `AppSettings` (next to `enabledLanguages`).
- Add `enabledGames: ['pokemon'],` to `DEFAULT_SETTINGS`.
- Add the parser (next to `parseLanguages`):

```ts
// enabled_games is a JSON text column; tolerate junk (['pokemon'] fallback)
// and guarantee 'pokemon' membership so the baseline game can't be disabled.
function parseGames(json: string): Game[] {
  try {
    const arr: unknown = JSON.parse(json)
    const games = Array.isArray(arr) ? arr.filter(isGame) : []
    return games.includes('pokemon') ? games : ['pokemon', ...games]
  } catch {
    return ['pokemon']
  }
}
```

- In `toRow`, destructure and serialise it alongside `enabledLanguages`:

```ts
function toRow(patch: Partial<Omit<AppSettings, 'conditionSellPct'>>) {
  const { enabledLanguages, enabledGames, ...rest } = patch
  return {
    ...rest,
    ...(enabledLanguages ? { enabledLanguages: JSON.stringify(enabledLanguages) } : {}),
    ...(enabledGames ? { enabledGames: JSON.stringify(enabledGames) } : {}),
  }
}
```

- In `toAppSettings`, add `enabledGames: parseGames(row.enabledGames),`.
- In `settingsPatchSchema`, add (mirroring `enabledLanguages`, guaranteeing pokemon):

```ts
  enabledGames: z.array(z.enum(GAME_IDS))
    .transform(games => [...new Set<Game>(['pokemon', ...games])]),
```

- [ ] **Step 8: Update the two `AppSettings` literals that now miss a required field**

- `lib/prices/sync.test.ts` — add `enabledGames: ['pokemon'],` to its `SETTINGS` const.
- `components/shared/SettingsProvider.tsx` — add `enabledGames: ['pokemon'],` to the `useSettings` fallback object (the `enabledLanguages: ['EN']` literal on line ~17).

- [ ] **Step 9: Run tests**

Run: `npx tsx --test lib/settings.test.ts lib/plan.test.ts` → PASS. Then `npm test` → all green (the test DB migrates via `applyMigrations`, picking up 0023). Then `npm run lint`.

- [ ] **Step 10: Commit**

```bash
git add lib/games.ts lib/plan.ts lib/plan.test.ts lib/db/schema.ts lib/db/migrations lib/settings.ts lib/settings.test.ts lib/prices/sync.test.ts components/shared/SettingsProvider.tsx
git commit -m "feat: game metadata, enabledGames setting, multiGame entitlement, catalogue_sync_state (migration 0023)"
```

---

### Task 2: External-id parser — `scryfall` + `ygoprodeck` sources

**Files:**
- Modify: `lib/sources/external-id.ts`
- Modify: `lib/sources/external-id.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `isGame` is not needed here; keep using `Language`/`isLanguage` (existing).
- Produces: `ParsedExternalId` union gains `{ source: 'scryfall'; id: string; finish: MtgFinish }` and `{ source: 'ygoprodeck'; passcode: string; setCode: string; rarity: string; id: string }`; constructors `scryfallExternalId(uuid: string, finish: MtgFinish): string`, `ygoExternalId(passcode, setCode, rarityCode): string`; `type MtgFinish = 'nonfoil' | 'foil' | 'etched'`; `raritySlug(rarityCode: string): string`.

- [ ] **Step 1: Write failing tests**

Add to `lib/sources/external-id.test.ts`:

```ts
import { scryfallExternalId, ygoExternalId, raritySlug } from '@/lib/sources/external-id'

test('scryfall nonfoil id has no finish suffix and parses back', () => {
  const ext = scryfallExternalId('4cbc6901-6a4a-4d0a-83ea-7eefa3b35021', 'nonfoil')
  assert.equal(ext, 'scryfall:4cbc6901-6a4a-4d0a-83ea-7eefa3b35021')
  assert.deepEqual(parseExternalId(ext), { source: 'scryfall', id: '4cbc6901-6a4a-4d0a-83ea-7eefa3b35021', finish: 'nonfoil' })
})

test('scryfall foil/etched ids carry the finish suffix', () => {
  assert.equal(scryfallExternalId('abc', 'foil'), 'scryfall:abc:foil')
  assert.deepEqual(parseExternalId('scryfall:abc:foil'), { source: 'scryfall', id: 'abc', finish: 'foil' })
  assert.deepEqual(parseExternalId('scryfall:abc:etched'), { source: 'scryfall', id: 'abc', finish: 'etched' })
})

test('ygoprodeck ids encode passcode, set code and a paren-free rarity slug', () => {
  const ext = ygoExternalId('46986414', 'CT13-EN003', '(UR)')
  assert.equal(ext, 'ygoprodeck:46986414:CT13-EN003:UR')
  assert.deepEqual(parseExternalId(ext), {
    source: 'ygoprodeck', passcode: '46986414', setCode: 'CT13-EN003', rarity: 'UR', id: ext,
  })
})

test('raritySlug strips non-alphanumerics', () => {
  assert.equal(raritySlug('(UR)'), 'UR')
  assert.equal(raritySlug('Secret Rare'), 'SecretRare')
})

test('unknown prefixes still fall back to a grandfathered pokemontcg parse', () => {
  assert.deepEqual(parseExternalId('xy7-54'), { source: 'pokemontcg', id: 'xy7-54' })
})
```

Run: `npx tsx --test lib/sources/external-id.test.ts` → FAIL.

- [ ] **Step 2: Extend `lib/sources/external-id.ts`**

Add the finish type + constructors and extend the union and parser. Full file after edit:

```ts
import { type Language, isLanguage } from '@/lib/games'

export type MtgFinish = 'nonfoil' | 'foil' | 'etched'

// Bare ids ("xy7-54") are grandfathered pokemontcg.io EN rows — never
// rewritten. New sources are namespaced:
//   tcgdex:<lang>:<raw id>                          (phase 1)
//   scryfall:<uuid>[:foil|:etched]                  (MTG; nonfoil has no suffix)
//   ygoprodeck:<passcode>:<set_code>:<rarity_slug>  (YGO; one row per printing)
export type ParsedExternalId =
  | { source: 'pokemontcg'; id: string }
  | { source: 'tcgdex'; language: Language; id: string }
  | { source: 'scryfall'; id: string; finish: MtgFinish }
  | { source: 'ygoprodeck'; passcode: string; setCode: string; rarity: string; id: string }

export function tcgdexExternalId(language: Exclude<Language, 'EN'>, rawId: string): string {
  return `tcgdex:${language.toLowerCase()}:${rawId}`
}

export function scryfallExternalId(uuid: string, finish: MtgFinish): string {
  return finish === 'nonfoil' ? `scryfall:${uuid}` : `scryfall:${uuid}:${finish}`
}

// Rarity codes carry parens ("(UR)") that mustn't reach an id; keep alnum only.
export function raritySlug(rarityCode: string): string {
  return rarityCode.replace(/[^a-zA-Z0-9]/g, '')
}

export function ygoExternalId(passcode: string, setCode: string, rarityCode: string): string {
  return `ygoprodeck:${passcode}:${setCode}:${raritySlug(rarityCode)}`
}

export function parseExternalId(externalId: string): ParsedExternalId {
  if (externalId.startsWith('tcgdex:')) {
    const rest = externalId.slice('tcgdex:'.length)
    const sep = rest.indexOf(':') // language codes may contain a hyphen, never a colon
    if (sep > 0) {
      const language = rest.slice(0, sep).toUpperCase()
      const id = rest.slice(sep + 1)
      if (isLanguage(language) && id) return { source: 'tcgdex', language, id }
    }
  }
  if (externalId.startsWith('scryfall:')) {
    const rest = externalId.slice('scryfall:'.length)
    const sep = rest.lastIndexOf(':')
    if (sep > 0) {
      const suffix = rest.slice(sep + 1)
      if (suffix === 'foil' || suffix === 'etched') {
        return { source: 'scryfall', id: rest.slice(0, sep), finish: suffix }
      }
    }
    if (rest) return { source: 'scryfall', id: rest, finish: 'nonfoil' }
  }
  if (externalId.startsWith('ygoprodeck:')) {
    const [passcode, setCode, rarity] = externalId.slice('ygoprodeck:'.length).split(':')
    if (passcode && setCode && rarity) {
      return { source: 'ygoprodeck', passcode, setCode, rarity, id: externalId }
    }
  }
  return { source: 'pokemontcg', id: externalId }
}
```

- [ ] **Step 3: Run tests** → `npx tsx --test lib/sources/external-id.test.ts` PASS. Then `npm test` (proves the tcgdex/pokemontcg regression path is unchanged).

- [ ] **Step 4: Commit**

```bash
git add lib/sources/external-id.ts lib/sources/external-id.test.ts
git commit -m "feat: external-id parser gains scryfall (per-finish) and ygoprodeck (per-printing) sources"
```

---

### Task 3: `NormalizedCard` type + Scryfall client & normalization

**Files:**
- Create: `lib/sources/types.ts`
- Create: `lib/apis/scryfall.ts`
- Create: `lib/apis/scryfall.test.ts`

**Interfaces:**
- Consumes: `Game`, `Language` (Task 1); `scryfallExternalId`, `MtgFinish` (Task 2).
- Produces: `NormalizedCard`, `NormalizedPrices` (from `@/lib/sources/types`); `fetchScryfallBulkUri(): Promise<string>`, `fetchScryfallPage(page: number): Promise<{ cards: ScryfallCard[]; hasMore: boolean }>`, `normalizeScryfallCard(card: ScryfallCard): NormalizedCard[]`, interface `ScryfallCard` (from `@/lib/apis/scryfall`); `class ScryfallError`.

- [ ] **Step 1: Write `lib/sources/types.ts`** (no test — a pure type module)

```ts
import type { Game, Language } from '@/lib/games'

// Native-currency prices from an upstream. Single market number per family —
// Scryfall and YGOPRODeck each quote one figure (no low/mid/high). The sync
// layer converts to GBP pence at the shop's rates. Emit null, never 0.
export interface NormalizedPrices {
  tcgplayerUsd: number | null // → price_cache.tcgplayer_market
  cardmarketEur: number | null // → price_cache.cardmarket_trend
}

// One catalogue row plus its prices, source-agnostic. `variant` follows the
// existing cards.variant convention: '' means the plain/base printing.
export interface NormalizedCard {
  game: Game
  language: Language
  name: string
  setName: string
  setNumber: string
  variant: string
  series: string | null
  externalId: string
  imageUrl: string | null
  imageUrlLarge: string | null
  prices: NormalizedPrices
}
```

- [ ] **Step 2: Write the failing Scryfall normalization tests**

`lib/apis/scryfall.test.ts` (pure normalisation only — network fns stay thin):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScryfallCard, type ScryfallCard } from '@/lib/apis/scryfall'

const bolt: ScryfallCard = {
  id: 'bolt-uuid', name: 'Lightning Bolt', lang: 'en', set: '2x2', set_name: 'Double Masters 2022',
  collector_number: '117', rarity: 'uncommon', finishes: ['nonfoil', 'foil'], games: ['paper', 'mtgo'],
  image_uris: { small: 'small.jpg', normal: 'normal.jpg', large: 'large.jpg' },
  prices: { usd: '2.49', usd_foil: '2.13', usd_etched: null, eur: '1.83', eur_foil: '2.04', tix: '1.61' },
}

test('a both-finishes printing yields two rows with per-finish prices and ids', () => {
  const rows = normalizeScryfallCard(bolt)
  assert.equal(rows.length, 2)
  const nonfoil = rows.find(r => r.variant === '')!
  const foil = rows.find(r => r.variant === 'Foil')!
  assert.equal(nonfoil.externalId, 'scryfall:bolt-uuid')
  assert.equal(nonfoil.prices.tcgplayerUsd, 2.49)
  assert.equal(nonfoil.prices.cardmarketEur, 1.83)
  assert.equal(foil.externalId, 'scryfall:bolt-uuid:foil')
  assert.equal(foil.prices.tcgplayerUsd, 2.13)
  assert.equal(foil.prices.cardmarketEur, 2.04)
  assert.equal(nonfoil.game, 'mtg')
  assert.equal(nonfoil.language, 'EN')
  assert.equal(nonfoil.setName, 'Double Masters 2022')
  assert.equal(nonfoil.setNumber, '117')
  assert.equal(nonfoil.series, '2x2')
  assert.equal(nonfoil.imageUrl, 'small.jpg')
  assert.equal(nonfoil.imageUrlLarge, 'large.jpg')
})

test('digital-only cards (no paper) are dropped', () => {
  assert.deepEqual(normalizeScryfallCard({ ...bolt, games: ['mtgo', 'arena'] }), [])
})

test('null/zero prices become null, not 0', () => {
  const rows = normalizeScryfallCard({ ...bolt, finishes: ['nonfoil'], prices: { usd: null, eur: '0.00' } as ScryfallCard['prices'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].prices.tcgplayerUsd, null)
  assert.equal(rows[0].prices.cardmarketEur, null)
})

test('etched finish maps usd_etched and leaves cardmarket null (no eur_etched upstream)', () => {
  const rows = normalizeScryfallCard({ ...bolt, finishes: ['etched'], prices: { usd_etched: '9.99' } as ScryfallCard['prices'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].variant, 'Etched')
  assert.equal(rows[0].externalId, 'scryfall:bolt-uuid:etched')
  assert.equal(rows[0].prices.tcgplayerUsd, 9.99)
  assert.equal(rows[0].prices.cardmarketEur, null)
})

test('card_faces image is used when top-level image_uris is absent (DFCs)', () => {
  const dfc = { ...bolt, image_uris: undefined, finishes: ['nonfoil'] as const,
    card_faces: [{ image_uris: { small: 'face-small.jpg', large: 'face-large.jpg' } }] }
  const [row] = normalizeScryfallCard(dfc as ScryfallCard)
  assert.equal(row.imageUrl, 'face-small.jpg')
})
```

Run: `npx tsx --test lib/apis/scryfall.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `lib/apis/scryfall.ts`**

```ts
import { scryfallExternalId, type MtgFinish } from '@/lib/sources/external-id'
import type { NormalizedCard } from '@/lib/sources/types'

const BASE = 'https://api.scryfall.com'
// Scryfall 403s the default fetch UA and requires an explicit Accept header.
const HEADERS = { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)', Accept: 'application/json' }
export const SCRYFALL_TIMEOUT_MS = 10_000

export class ScryfallError extends Error {}

interface ScryfallImageUris { small?: string; normal?: string; large?: string }

export interface ScryfallCard {
  id: string
  name: string
  lang: string
  set: string
  set_name: string
  collector_number: string
  rarity?: string
  finishes: MtgFinish[]
  games: string[]
  digital?: boolean
  image_uris?: ScryfallImageUris
  card_faces?: { image_uris?: ScryfallImageUris }[]
  prices: {
    usd?: string | null; usd_foil?: string | null; usd_etched?: string | null
    eur?: string | null; eur_foil?: string | null; tix?: string | null
  }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(SCRYFALL_TIMEOUT_MS) })
  } catch (e) {
    throw new ScryfallError(`Scryfall unreachable for ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new ScryfallError(`Scryfall ${res.status} for ${url}`)
  return await res.json() as T
}

// The download URI of the current `default_cards` bulk file (one object per
// English printing). Used only by the off-cron import script.
export async function fetchScryfallBulkUri(): Promise<string> {
  const data = await getJson<{ download_uri: string }>(`${BASE}/bulk-data/default-cards`)
  return data.download_uri
}

// One page (175 cards) of the paged catalogue crawl the nightly sweep walks.
// `game:paper lang:en unique:prints` == the default_cards contents.
export async function fetchScryfallPage(page: number): Promise<{ cards: ScryfallCard[]; hasMore: boolean }> {
  const params = new URLSearchParams({ q: 'game:paper lang:en', unique: 'prints', page: String(page) })
  try {
    const body = await getJson<{ data: ScryfallCard[]; has_more: boolean }>(`${BASE}/cards/search?${params}`)
    return { cards: body.data, hasMore: body.has_more }
  } catch (e) {
    // A search past the last page 404s — treat as a clean end, not an error.
    if (e instanceof ScryfallError && e.message.includes('404')) return { cards: [], hasMore: false }
    throw e
  }
}

// Scryfall emits 0/absent for prices it doesn't have — 0 is "no data".
const money = (v: string | null | undefined): number | null => {
  const n = v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const FINISH_VARIANT: Record<MtgFinish, string> = { nonfoil: '', foil: 'Foil', etched: 'Etched' }

function priceForFinish(prices: ScryfallCard['prices'], finish: MtgFinish): NormalizedCard['prices'] {
  if (finish === 'foil') return { tcgplayerUsd: money(prices.usd_foil), cardmarketEur: money(prices.eur_foil) }
  if (finish === 'etched') return { tcgplayerUsd: money(prices.usd_etched), cardmarketEur: null }
  return { tcgplayerUsd: money(prices.usd), cardmarketEur: money(prices.eur) }
}

// One NormalizedCard per paper finish. Non-paper (digital-only) cards drop out.
export function normalizeScryfallCard(card: ScryfallCard): NormalizedCard[] {
  if (!card.games?.includes('paper')) return []
  const img = card.image_uris ?? card.card_faces?.[0]?.image_uris
  return card.finishes.map(finish => ({
    game: 'mtg' as const,
    language: 'EN' as const,
    name: card.name,
    setName: card.set_name,
    setNumber: card.collector_number,
    variant: FINISH_VARIANT[finish],
    series: card.set, // the set code (e.g. "2x2"); set_name holds the human name
    externalId: scryfallExternalId(card.id, finish),
    imageUrl: img?.small ?? null,
    imageUrlLarge: img?.large ?? null,
    prices: priceForFinish(card.prices, finish),
  }))
}
```

- [ ] **Step 4: Run tests** → `npx tsx --test lib/apis/scryfall.test.ts` PASS, then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/types.ts lib/apis/scryfall.ts lib/apis/scryfall.test.ts
git commit -m "feat: NormalizedCard type + Scryfall client and per-finish normalization"
```

---

### Task 4: YGOPRODeck client & normalization

**Files:**
- Create: `lib/apis/ygoprodeck.ts`
- Create: `lib/apis/ygoprodeck.test.ts`

**Interfaces:**
- Consumes: `ygoExternalId` (Task 2); `NormalizedCard` (Task 3).
- Produces: `fetchYgoprodeckDump(): Promise<YgoCard[]>`, `normalizeYgoCard(card: YgoCard): NormalizedCard[]`, interface `YgoCard` (from `@/lib/apis/ygoprodeck`); `class YgoprodeckError`.

- [ ] **Step 1: Write the failing tests**

`lib/apis/ygoprodeck.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeYgoCard, type YgoCard } from '@/lib/apis/ygoprodeck'

const darkMagician: YgoCard = {
  id: 46986414, name: 'Dark Magician', type: 'Normal Monster',
  card_images: [{ image_url: 'dm.jpg', image_url_small: 'dm-small.jpg' }],
  card_prices: [{ cardmarket_price: '0.02', tcgplayer_price: '0.27' }],
  card_sets: [
    { set_name: 'Legend of Blue Eyes', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' },
    { set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '1.50' },
  ],
}

test('one row per printing, priced from set_price (USD), cardmarket null', () => {
  const rows = normalizeYgoCard(darkMagician)
  assert.equal(rows.length, 2)
  const lob = rows.find(r => r.setNumber === 'LOB-005')!
  assert.equal(lob.game, 'yugioh')
  assert.equal(lob.language, 'EN')
  assert.equal(lob.name, 'Dark Magician')
  assert.equal(lob.setName, 'Legend of Blue Eyes')
  assert.equal(lob.variant, 'Ultra Rare')
  assert.equal(lob.externalId, 'ygoprodeck:46986414:LOB-005:UR')
  assert.equal(lob.prices.tcgplayerUsd, 120)   // the rare printing is priced high
  assert.equal(lob.prices.cardmarketEur, null) // no honest per-printing EUR
  assert.equal(lob.imageUrl, 'dm-small.jpg')
  const sdy = rows.find(r => r.setNumber === 'SDY-006')!
  assert.equal(sdy.prices.tcgplayerUsd, 1.5)   // the common is priced low — different row
})

test('a 0.00 set_price becomes null (no-price workflow), not a 0 quote', () => {
  const rows = normalizeYgoCard({ ...darkMagician,
    card_sets: [{ set_name: 'X', set_code: 'X-001', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '0.00' }] })
  assert.equal(rows[0].prices.tcgplayerUsd, null)
})

test('a card with no card_sets (unreleased/anime) yields no rows', () => {
  assert.deepEqual(normalizeYgoCard({ ...darkMagician, card_sets: undefined }), [])
})
```

Run: `npx tsx --test lib/apis/ygoprodeck.test.ts` → FAIL.

- [ ] **Step 2: Write `lib/apis/ygoprodeck.ts`**

```ts
import { ygoExternalId } from '@/lib/sources/external-id'
import type { NormalizedCard } from '@/lib/sources/types'

const URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
const HEADERS = { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)' }
export const YGO_TIMEOUT_MS = 30_000 // the whole-game dump is a few MB

export class YgoprodeckError extends Error {}

interface YgoSet { set_name: string; set_code: string; set_rarity: string; set_rarity_code: string; set_price: string }
interface YgoImage { image_url: string; image_url_small?: string }
interface YgoPrice { cardmarket_price?: string; tcgplayer_price?: string }

export interface YgoCard {
  id: number
  name: string
  type: string
  card_sets?: YgoSet[]
  card_images?: YgoImage[]
  card_prices?: YgoPrice[]
}

// The entire game in one call — all cards, each with every printing. Cheap
// enough (a few MB) to refresh fully every night.
export async function fetchYgoprodeckDump(): Promise<YgoCard[]> {
  let res: Response
  try {
    res = await fetch(URL, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(YGO_TIMEOUT_MS) })
  } catch (e) {
    throw new YgoprodeckError(`YGOPRODeck unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new YgoprodeckError(`YGOPRODeck ${res.status}`)
  const body = await res.json() as { data?: YgoCard[] }
  return body.data ?? []
}

const money = (v: string | undefined): number | null => {
  const n = v == null ? NaN : parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// One NormalizedCard per printing (set × rarity). Priced from that printing's
// set_price (USD → tcgplayer). Cardmarket is left null: YGOPRODeck's only EUR
// figure is a per-card aggregate that would misprice rare printings.
export function normalizeYgoCard(card: YgoCard): NormalizedCard[] {
  const img = card.card_images?.[0]
  return (card.card_sets ?? [])
    .filter(s => s.set_code)
    .map(s => ({
      game: 'yugioh' as const,
      language: 'EN' as const,
      name: card.name,
      setName: s.set_name,
      setNumber: s.set_code,
      variant: s.set_rarity,
      series: s.set_name,
      externalId: ygoExternalId(String(card.id), s.set_code, s.set_rarity_code),
      imageUrl: img?.image_url_small ?? null,
      imageUrlLarge: img?.image_url ?? null,
      prices: { tcgplayerUsd: money(s.set_price), cardmarketEur: null },
    }))
}
```

- [ ] **Step 3: Run tests** → `npx tsx --test lib/apis/ygoprodeck.test.ts` PASS, then `npm test`.

- [ ] **Step 4: Commit**

```bash
git add lib/apis/ygoprodeck.ts lib/apis/ygoprodeck.test.ts
git commit -m "feat: YGOPRODeck client + per-printing normalization (set_price → tcgplayer, cardmarket null)"
```

---

### Task 5: Normalized upsert + Scryfall sweep (paged/cursored) + YGO sweep (one-call)

**Files:**
- Create: `lib/sources/upsert.ts`, `lib/sources/upsert.test.ts`
- Create: `lib/sources/scryfall-sweep.ts`, `lib/sources/scryfall-sweep.test.ts`
- Create: `lib/sources/ygoprodeck-sweep.ts`, `lib/sources/ygoprodeck-sweep.test.ts`

**Interfaces:**
- Consumes: `NormalizedCard` (Task 3); `normalizeScryfallCard`/`fetchScryfallPage` (Task 3); `normalizeYgoCard`/`fetchYgoprodeckDump` (Task 4); `chunked` from `@/lib/prices/sync`; `catalogueSyncState` (Task 1); `AppSettings` (Task 1).
- Produces: `upsertNormalizedCards(dbc, rows, settings, result): Promise<void>` + `type SweepResult` (from `@/lib/sources/upsert`); `sweepScryfall(settings, dbc?, opts?, deps?): Promise<SweepResult>` (from `@/lib/sources/scryfall-sweep`); `sweepYgoprodeck(settings, dbc?, deps?): Promise<SweepResult>` (from `@/lib/sources/ygoprodeck-sweep`). `SweepResult = { cardsSeen: number; newCards: number; pricesUpdated: number; failed: number }`.

- [ ] **Step 1: Write the failing upsert test**

`lib/sources/upsert.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards, priceCache } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { NormalizedCard } from '@/lib/sources/types'

const settings = { ...DEFAULT_SETTINGS, usdToGbp: 0.8, eurToGbp: 0.85, highValueThreshold: 5000 }
const row: NormalizedCard = {
  game: 'mtg', language: 'EN', name: 'Lightning Bolt', setName: 'Double Masters 2022', setNumber: '117',
  variant: 'Foil', series: '2x2', externalId: 'scryfall:bolt:foil', imageUrl: 's.jpg', imageUrlLarge: 'l.jpg',
  prices: { tcgplayerUsd: 2.13, cardmarketEur: 2.04 },
}
const fresh = (): SweepResult => ({ cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 })

test('inserts a card row and its prices converted to GBP pence', async () => {
  const db = await createTestDb()
  const result = fresh()
  await upsertNormalizedCards(db, [row], settings, result)
  assert.equal(result.newCards, 1)
  const [c] = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(c.game, 'mtg'); assert.equal(c.variant, 'Foil'); assert.equal(c.setNumber, '117')
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(2.13 * 0.8 * 100))
  assert.equal(p.cardmarketTrend, Math.round(2.04 * 0.85 * 100))
})

test('re-upsert heals identity + refreshes price without duplicating rows', async () => {
  const db = await createTestDb()
  await upsertNormalizedCards(db, [row], settings, fresh())
  const second = fresh()
  await upsertNormalizedCards(db, [{ ...row, name: 'Lightning Bolt (errata)', prices: { tcgplayerUsd: 9, cardmarketEur: null } }], settings, second)
  assert.equal(second.newCards, 0)
  const all = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'Lightning Bolt (errata)')
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, all[0].id))
  assert.equal(p.tcgplayerMarket, Math.round(9 * 0.8 * 100))
})
```

Run: `npx tsx --test lib/sources/upsert.test.ts` → FAIL.

- [ ] **Step 2: Write `lib/sources/upsert.ts`**

```ts
import { sql, eq, inArray } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cards, priceCache } from '@/lib/db/schema'
import { chunked } from '@/lib/prices/sync'
import { usdToGbp, eurToGbp } from '@/lib/pricing'
import type { AppSettings } from '@/lib/settings'
import type { NormalizedCard, NormalizedPrices } from '@/lib/sources/types'

export interface SweepResult { cardsSeen: number; newCards: number; pricesUpdated: number; failed: number }

const CHUNK = 100

// Idempotent upsert of a batch of normalized rows + their prices. Identity is
// healed on conflict (external_id is the key); prices convert native→pence at
// the shop's rates here (keeping money server-canonical). Shared by every
// game's sweep and the import script.
export async function upsertNormalizedCards(
  dbc: Db, rows: NormalizedCard[], settings: AppSettings, result: SweepResult,
): Promise<void> {
  if (rows.length === 0) return
  result.cardsSeen += rows.length
  const ids = rows.map(r => r.externalId)
  const existing = await dbc.select({ externalId: cards.externalId }).from(cards).where(inArray(cards.externalId, ids))
  const known = new Set(existing.map(r => r.externalId))
  result.newCards += rows.filter(r => !known.has(r.externalId)).length

  const idByExternal = new Map<string, number>()
  for (const chunk of chunked(rows, CHUNK)) {
    const inserted = await dbc.insert(cards).values(chunk.map(r => ({
      name: r.name, game: r.game, language: r.language, setName: r.setName, setNumber: r.setNumber,
      variant: r.variant, series: r.series, externalId: r.externalId,
      imageUrl: r.imageUrl, imageUrlLarge: r.imageUrlLarge,
    }))).onConflictDoUpdate({
      target: cards.externalId,
      set: {
        name: sql`excluded.name`, setName: sql`excluded.set_name`, setNumber: sql`excluded.set_number`,
        variant: sql`excluded.variant`, series: sql`excluded.series`,
        imageUrl: sql`excluded.image_url`, imageUrlLarge: sql`excluded.image_url_large`,
      },
    }).returning({ id: cards.id, externalId: cards.externalId })
    for (const r of inserted) idByExternal.set(r.externalId!, r.id)
  }

  const priceRows = rows.flatMap(r => {
    const cardId = idByExternal.get(r.externalId)
    if (cardId == null) return []
    const market = usdToGbp(r.prices.tcgplayerUsd, settings.usdToGbp)
    return [{
      cardId,
      tcgplayerMarket: market,
      cardmarketTrend: eurToGbp(r.prices.cardmarketEur, settings.eurToGbp),
      lastSyncedAt: new Date().toISOString(),
      isHighValue: (market ?? 0) >= settings.highValueThreshold,
    }]
  })
  for (const chunk of chunked(priceRows, CHUNK)) {
    await dbc.insert(priceCache).values(chunk).onConflictDoUpdate({
      target: priceCache.cardId,
      set: {
        tcgplayerMarket: sql`excluded.tcgplayer_market`,
        cardmarketTrend: sql`excluded.cardmarket_trend`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        isHighValue: sql`excluded.is_high_value`,
      },
    })
    result.pricesUpdated += chunk.length
  }
}

// Price-only refresh of one already-known card by external id. Used by the
// per-card MTG/YGO refresh (Task 6): updates the market columns and stamps the
// freshness timestamps, without rewriting identity or recomputing isHighValue
// (which the sweep owns). Takes rates only — no settings round-trip per card.
export async function writePriceForExternalId(
  dbc: Db, externalId: string, prices: NormalizedPrices, rates: { usd: number; eur: number },
): Promise<void> {
  const [card] = await dbc.select({ id: cards.id }).from(cards).where(eq(cards.externalId, externalId))
  if (!card) return
  const now = new Date().toISOString()
  await dbc.insert(priceCache).values({
    cardId: card.id,
    tcgplayerMarket: usdToGbp(prices.tcgplayerUsd, rates.usd),
    cardmarketTrend: eurToGbp(prices.cardmarketEur, rates.eur),
    cardmarketSyncedAt: now, // mark "market checked" so search's on-demand refresh dedupes
    lastSyncedAt: now,
  }).onConflictDoUpdate({
    target: priceCache.cardId,
    set: {
      tcgplayerMarket: sql`excluded.tcgplayer_market`,
      cardmarketTrend: sql`excluded.cardmarket_trend`,
      cardmarketSyncedAt: sql`excluded.cardmarket_synced_at`,
      lastSyncedAt: sql`excluded.last_synced_at`,
    },
  })
}
```

Add a test for the helper to `lib/sources/upsert.test.ts`:

```ts
import { writePriceForExternalId } from '@/lib/sources/upsert'

test('writePriceForExternalId updates only prices + freshness, not identity', async () => {
  const db = await createTestDb()
  await upsertNormalizedCards(db, [row], settings, fresh()) // creates scryfall:bolt:foil
  await writePriceForExternalId(db, 'scryfall:bolt:foil', { tcgplayerUsd: 5, cardmarketEur: null }, { usd: 0.8, eur: 0.85 })
  const [c] = await db.select().from(cards).where(eq(cards.externalId, 'scryfall:bolt:foil'))
  assert.equal(c.name, 'Lightning Bolt') // identity untouched
  const [p] = await db.select().from(priceCache).where(eq(priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(5 * 0.8 * 100))
  assert.ok(p.cardmarketSyncedAt) // stamped
})
```

Run: `npx tsx --test lib/sources/upsert.test.ts` → PASS.

- [ ] **Step 3: Write the failing Scryfall-sweep tests**

`lib/sources/scryfall-sweep.test.ts` (inject a paged fetcher; assert budget + cursor):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards, catalogueSyncState } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import type { ScryfallCard } from '@/lib/apis/scryfall'

const card = (id: string): ScryfallCard => ({
  id, name: `Card ${id}`, lang: 'en', set: 'tst', set_name: 'Test', collector_number: id,
  rarity: 'common', finishes: ['nonfoil'], games: ['paper'], image_uris: { small: 's', large: 'l' },
  prices: { usd: '1.00', eur: '0.90' },
})
// three pages of one card each; page 4 empty
const pages: Record<number, { cards: ScryfallCard[]; hasMore: boolean }> = {
  1: { cards: [card('a')], hasMore: true },
  2: { cards: [card('b')], hasMore: true },
  3: { cards: [card('c')], hasMore: false },
}
const deps = { fetchPage: async (p: number) => pages[p] ?? { cards: [], hasMore: false } }
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'mtg' as const] }

test('a budgeted run imports up to `maxPages` and persists the next-page cursor', async () => {
  const db = await createTestDb()
  const r = await sweepScryfall(settings, db, { maxPages: 2 }, deps)
  assert.equal(r.newCards, 2) // pages 1-2
  const [state] = await db.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  assert.equal(state.cursor, '3') // resume here next run
})

test('resuming from the cursor finishes the catalogue and wraps to page 1', async () => {
  const db = await createTestDb()
  await sweepScryfall(settings, db, { maxPages: 2 }, deps) // cursor → 3
  const r = await sweepScryfall(settings, db, { maxPages: 2 }, deps) // page 3, then end
  assert.equal(r.newCards, 1) // page 3 (a,b already known)
  const [state] = await db.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  assert.equal(state.cursor, '1') // wrapped for the next cycle
  assert.equal((await db.select().from(cards).where(eq(cards.game, 'mtg'))).length, 3)
})

test('does nothing when mtg is not enabled', async () => {
  const db = await createTestDb()
  const r = await sweepScryfall({ ...settings, enabledGames: ['pokemon'] }, db, { maxPages: 5 }, deps)
  assert.equal(r.cardsSeen, 0)
})
```

Run: `npx tsx --test lib/sources/scryfall-sweep.test.ts` → FAIL.

- [ ] **Step 4: Write `lib/sources/scryfall-sweep.ts`**

```ts
import { eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { catalogueSyncState } from '@/lib/db/schema'
import { fetchScryfallPage, normalizeScryfallCard } from '@/lib/apis/scryfall'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export const SCRYFALL_MAX_PAGES = 40 // ~175 cards/page; full ~100k catalogue cycles ~2 weeks

export interface ScryfallSweepDeps { fetchPage?: typeof fetchScryfallPage }

async function readCursor(dbc: Db): Promise<number> {
  const [row] = await dbc.select().from(catalogueSyncState).where(eq(catalogueSyncState.game, 'mtg'))
  const n = row?.cursor ? parseInt(row.cursor, 10) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

async function writeCursor(dbc: Db, page: number): Promise<void> {
  await dbc.insert(catalogueSyncState).values({ game: 'mtg', cursor: String(page), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: catalogueSyncState.game, set: { cursor: String(page), updatedAt: new Date().toISOString() } })
}

// Bounded, cursored crawl of Scryfall's paged catalogue. Resumes at the stored
// page, imports up to `maxPages`, and persists where to resume next run — so
// nightly MTG work is capped regardless of catalogue size. Wraps to page 1 at
// the end so the whole catalogue re-prices over successive nights. Skips
// entirely unless MTG is enabled.
export async function sweepScryfall(
  settings: AppSettings, dbc: Db = db, opts: { maxPages?: number } = {}, deps: ScryfallSweepDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('mtg')) return result
  const fetchPage = deps.fetchPage ?? fetchScryfallPage
  const maxPages = opts.maxPages ?? SCRYFALL_MAX_PAGES

  let page = await readCursor(dbc)
  for (let i = 0; i < maxPages; i++) {
    let batch
    try {
      batch = await fetchPage(page)
    } catch {
      result.failed++
      break // upstream hiccup — keep the cursor, retry next run
    }
    const rows = batch.cards.flatMap(normalizeScryfallCard)
    await upsertNormalizedCards(dbc, rows, settings, result)
    if (!batch.hasMore) { page = 1; break } // wrapped
    page++
  }
  await writeCursor(dbc, page)
  return result
}
```

Run: `npx tsx --test lib/sources/scryfall-sweep.test.ts` → PASS.

- [ ] **Step 5: Write the failing YGO-sweep test**

`lib/sources/ygoprodeck-sweep.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import type { YgoCard } from '@/lib/apis/ygoprodeck'

const dump: YgoCard[] = [{
  id: 46986414, name: 'Dark Magician', type: 'Normal Monster',
  card_images: [{ image_url: 'dm.jpg', image_url_small: 'dm-s.jpg' }], card_prices: [{}],
  card_sets: [
    { set_name: 'LOB', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' },
    { set_name: 'SDY', set_code: 'SDY-006', set_rarity: 'Common', set_rarity_code: '(C)', set_price: '1.50' },
  ],
}]
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'yugioh' as const] }

test('imports every printing as its own row when yugioh is enabled', async () => {
  const db = await createTestDb()
  const r = await sweepYgoprodeck(settings, db, { fetchDump: async () => dump })
  assert.equal(r.newCards, 2)
  const rows = await db.select().from(cards).where(eq(cards.game, 'yugioh'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(c => c.setNumber).sort(), ['LOB-005', 'SDY-006'])
})

test('does nothing when yugioh is not enabled', async () => {
  const db = await createTestDb()
  const r = await sweepYgoprodeck({ ...settings, enabledGames: ['pokemon'] }, db, { fetchDump: async () => dump })
  assert.equal(r.cardsSeen, 0)
})
```

Run: `npx tsx --test lib/sources/ygoprodeck-sweep.test.ts` → FAIL.

- [ ] **Step 6: Write `lib/sources/ygoprodeck-sweep.ts`**

```ts
import { db, type Db } from '@/lib/db'
import { fetchYgoprodeckDump, normalizeYgoCard } from '@/lib/apis/ygoprodeck'
import { chunked } from '@/lib/prices/sync'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface YgoSweepDeps { fetchDump?: typeof fetchYgoprodeckDump }

// The whole Yu-Gi-Oh! catalogue in one call, upserted per printing. Cheap
// enough to run in full each night, so no cursor. Skips unless enabled.
export async function sweepYgoprodeck(
  settings: AppSettings, dbc: Db = db, deps: YgoSweepDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('yugioh')) return result
  let dump
  try {
    dump = await (deps.fetchDump ?? fetchYgoprodeckDump)()
  } catch {
    result.failed++
    return result
  }
  const rows = dump.flatMap(normalizeYgoCard)
  // Upsert in card-sized batches so one huge multi-row statement never trips
  // SQLite's variable limit (upsertNormalizedCards re-chunks to 100 anyway).
  for (const batch of chunked(rows, 500)) {
    await upsertNormalizedCards(dbc, batch, settings, result)
  }
  return result
}
```

Run: `npx tsx --test lib/sources/ygoprodeck-sweep.test.ts` → PASS. Then `npm test`.

- [ ] **Step 7: Commit**

```bash
git add lib/sources/upsert.ts lib/sources/upsert.test.ts lib/sources/scryfall-sweep.ts lib/sources/scryfall-sweep.test.ts lib/sources/ygoprodeck-sweep.ts lib/sources/ygoprodeck-sweep.test.ts
git commit -m "feat: shared normalized upsert + Scryfall paged/cursored sweep + YGOPRODeck one-call sweep"
```

---

### Task 6: Source registry + per-card refresh dispatch for MTG/YGO

**Files:**
- Create: `lib/sources/registry.ts`, `lib/sources/registry.test.ts`
- Modify: `lib/prices/sync.ts` (`syncMarketPricesForCard` routes scryfall/ygo per-card)
- Modify: `lib/prices/sync.test.ts` (new dispatch tests)

**Interfaces:**
- Consumes: `parseExternalId` (Task 2); `fetchScryfallCard` (new, Task 6 step 1); `fetchYgoprodeckCard` (new, Task 6 step 1); `writePriceForExternalId` (Task 5); `normalizeScryfallCard`/`normalizeYgoCard` (Tasks 3/4).
- Produces: `getCatalogueSource(game: Game): CatalogueSource | undefined`, `CATALOGUE_SOURCES` (from `@/lib/sources/registry`); `interface CatalogueSource { game: Game; languages: Language[]; sweep: (settings: AppSettings, dbc?: Db) => Promise<SweepResult>; refreshPrices?: (externalId: string, rates: { usd: number; eur: number }, dbc: Db) => Promise<void> }`. `syncMarketPricesForCard` keeps its signature — gains scryfall/ygo branches internally that pass the `rates` it already holds. `syncStaleCardmarket`'s candidate query is scoped to `cards.game = 'pokemon'`.

> Per-card refresh keeps stocked and just-searched MTG/YGO cards current between nightly sweeps (the in-stock sync and on-demand search refresh already call `syncMarketPricesForCard`). It fetches a single card and re-upserts through the shared path.

- [ ] **Step 1: Add single-card fetchers to the two clients**

In `lib/apis/scryfall.ts` add:

```ts
// One card by Scryfall id — used by the per-card refresh (in-stock + on-demand).
export async function fetchScryfallCard(id: string): Promise<ScryfallCard | null> {
  try {
    return await getJson<ScryfallCard>(`${BASE}/cards/${encodeURIComponent(id)}`)
  } catch (e) {
    if (e instanceof ScryfallError && e.message.includes('404')) return null
    throw e
  }
}
```

In `lib/apis/ygoprodeck.ts` add:

```ts
// One card (all its printings) by passcode — per-card refresh.
export async function fetchYgoprodeckCard(passcode: string): Promise<YgoCard | null> {
  let res: Response
  try {
    res = await fetch(`${URL}?id=${encodeURIComponent(passcode)}`, { headers: HEADERS, cache: 'no-store', signal: AbortSignal.timeout(YGO_TIMEOUT_MS) })
  } catch (e) {
    throw new YgoprodeckError(`YGOPRODeck unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 400) return null // YGOPRODeck 400s an unknown passcode
  if (!res.ok) throw new YgoprodeckError(`YGOPRODeck ${res.status}`)
  const body = await res.json() as { data?: YgoCard[] }
  return body.data?.[0] ?? null
}
```

- [ ] **Step 2: Write the failing registry test**

`lib/sources/registry.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { getCatalogueSource } from '@/lib/sources/registry'

test('every game resolves to exactly one catalogue source', () => {
  assert.equal(getCatalogueSource('pokemon')?.game, 'pokemon')
  assert.equal(getCatalogueSource('mtg')?.game, 'mtg')
  assert.equal(getCatalogueSource('yugioh')?.game, 'yugioh')
})

test('mtg and yugioh sources expose a per-card refresh; all expose a sweep', () => {
  assert.equal(typeof getCatalogueSource('mtg')?.sweep, 'function')
  assert.equal(typeof getCatalogueSource('mtg')?.refreshPrices, 'function')
  assert.equal(typeof getCatalogueSource('yugioh')?.refreshPrices, 'function')
})
```

Run: `npx tsx --test lib/sources/registry.test.ts` → FAIL.

- [ ] **Step 3: Write `lib/sources/registry.ts`**

```ts
import type { Db } from '@/lib/db'
import { type Game, type Language, GAMES } from '@/lib/games'
import type { AppSettings } from '@/lib/settings'
import { parseExternalId } from '@/lib/sources/external-id'
import { writePriceForExternalId, type SweepResult } from '@/lib/sources/upsert'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import { fetchScryfallCard, normalizeScryfallCard } from '@/lib/apis/scryfall'
import { fetchYgoprodeckCard, normalizeYgoCard } from '@/lib/apis/ygoprodeck'

export interface CatalogueSource {
  game: Game
  languages: Language[]
  sweep: (settings: AppSettings, dbc?: Db) => Promise<SweepResult>
  // Optional: re-price a single already-known card (in-stock + on-demand).
  // Rates-only (the caller already resolved them) — no per-card settings read.
  refreshPrices?: (externalId: string, rates: { usd: number; eur: number }, dbc: Db) => Promise<void>
}

// One catalogue-writing source per game (spec §2: exactly one per (game,
// language) — Pokémon's EN/CJK split lives inside its own sync path, not here).
// Pokémon keeps its existing sweep path (lib/prices/*), so it is intentionally
// absent from this registry; getCatalogueSource returns undefined and callers
// fall back to the Pokémon-specific machinery. MTG/YGO are fully registry-driven.
const scryfallRefresh: CatalogueSource['refreshPrices'] = async (externalId, rates, dbc) => {
  const parsed = parseExternalId(externalId)
  if (parsed.source !== 'scryfall') return
  const card = await fetchScryfallCard(parsed.id)
  if (!card) return
  // normalize yields a row per finish; take the one matching this external id.
  const match = normalizeScryfallCard(card).find(r => r.externalId === externalId)
  if (match) await writePriceForExternalId(dbc, externalId, match.prices, rates)
}

const ygoRefresh: CatalogueSource['refreshPrices'] = async (externalId, rates, dbc) => {
  const parsed = parseExternalId(externalId)
  if (parsed.source !== 'ygoprodeck') return
  const card = await fetchYgoprodeckCard(parsed.passcode)
  if (!card) return
  const match = normalizeYgoCard(card).find(r => r.externalId === externalId)
  if (match) await writePriceForExternalId(dbc, externalId, match.prices, rates)
}

export const CATALOGUE_SOURCES: Partial<Record<Game, CatalogueSource>> = {
  mtg: { game: 'mtg', languages: GAMES.mtg.languages, sweep: (s, dbc) => sweepScryfall(s, dbc), refreshPrices: scryfallRefresh },
  yugioh: { game: 'yugioh', languages: GAMES.yugioh.languages, sweep: (s, dbc) => sweepYgoprodeck(s, dbc), refreshPrices: ygoRefresh },
}

export function getCatalogueSource(game: Game): CatalogueSource | undefined {
  return CATALOGUE_SOURCES[game]
}
```

Run: `npx tsx --test lib/sources/registry.test.ts` → PASS.

- [ ] **Step 4: Write the failing dispatch tests in `lib/prices/sync.test.ts`**

`sync.test.ts` already stubs `globalThis.fetch`. Extend its `stubFetch` to answer Scryfall/YGO single-card URLs, then assert `syncMarketPricesForCard` routes to them. Add near the other helpers:

```ts
// add to stubFetch's opts type:
//   scryfallCards?: Record<string, unknown | 'missing'>
//   ygoCards?: Record<string, unknown | 'missing'>
// and in the fetch stub body, before the final fallthrough:
    if (url.includes('api.scryfall.com/cards/')) {
      const id = url.split('/').pop()!
      const c = opts.scryfallCards?.[id]
      if (c === 'missing') return new Response('no', { status: 404 })
      if (c) return Response.json(c)
    }
    if (url.includes('ygoprodeck.com') && url.includes('id=')) {
      const id = new URL(url).searchParams.get('id')!
      const c = opts.ygoCards?.[id]
      if (c === 'missing') return new Response('no', { status: 400 })
      if (c) return Response.json({ data: [c] })
    }
```

Then the tests:

```ts
test('an mtg external id re-prices via Scryfall into price_cache (GBP pence)', async () => {
  const [c] = await db.insert(schema.cards).values({
    name: 'Bolt', game: 'mtg', language: 'EN', setName: '2X2', setNumber: '117', variant: 'Foil',
    externalId: 'scryfall:bolt:foil',
  }).returning()
  stubFetch({ scryfallCards: { bolt: {
    id: 'bolt', name: 'Bolt', lang: 'en', set: '2x2', set_name: '2X2', collector_number: '117',
    finishes: ['nonfoil', 'foil'], games: ['paper'], prices: { usd_foil: '2.00', eur_foil: '1.50' },
  } } })
  await syncMarketPricesForCard(c.id, 'scryfall:bolt:foil', 'Foil', { eur: 0.85, usd: 0.8 }, db)
  const [p] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(2 * 0.8 * 100))
  assert.equal(p.cardmarketTrend, Math.round(1.5 * 0.85 * 100))
})

test('a yugioh external id re-prices via YGOPRODeck (set_price → tcgplayer)', async () => {
  const [c] = await db.insert(schema.cards).values({
    name: 'Dark Magician', game: 'yugioh', language: 'EN', setName: 'LOB', setNumber: 'LOB-005', variant: 'Ultra Rare',
    externalId: 'ygoprodeck:46986414:LOB-005:UR',
  }).returning()
  stubFetch({ ygoCards: { '46986414': {
    id: 46986414, name: 'Dark Magician', type: 'Normal Monster',
    card_sets: [{ set_name: 'LOB', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '120.00' }],
  } } })
  await syncMarketPricesForCard(c.id, 'ygoprodeck:46986414:LOB-005:UR', 'Ultra Rare', { eur: 0.85, usd: 0.8 }, db)
  const [p] = await db.select().from(schema.priceCache).where(eq(schema.priceCache.cardId, c.id))
  assert.equal(p.tcgplayerMarket, Math.round(120 * 0.8 * 100))
})
```

Run: `npx tsx --test lib/prices/sync.test.ts` → FAIL (`scryfall`/`ygoprodeck` ids fall through to the pokemontcg path and write nothing).

- [ ] **Step 5: Add the dispatch branch in `lib/prices/sync.ts`**

Add the import `import { getCatalogueSource } from '@/lib/sources/registry'`. In `syncMarketPricesForCard`, after the existing `if (parsed.source === 'tcgdex' …)` block, add scryfall/ygo routing — passing the `rates` the function already received (no settings round-trip):

```ts
  if (parsed.source === 'scryfall' || parsed.source === 'ygoprodeck') {
    const source = getCatalogueSource(parsed.source === 'scryfall' ? 'mtg' : 'yugioh')
    await source?.refreshPrices?.(externalId, rates, dbc)
    return
  }
```

Run: `npx tsx --test lib/prices/sync.test.ts` → the two dispatch tests PASS.

- [ ] **Step 6: Scope the Cardmarket rotation to Pokémon (write the failing test first)**

The stalest-first Cardmarket rotation (`syncStaleCardmarket`) orders by `cardmarketSyncedAt` with NULLs first. Sweep-priced MTG/YGO rows have a null `cardmarketSyncedAt`, so without a guard they would dominate the rotation and get re-fetched one-at-a-time via Scryfall/YGO every night — redundant with their sweeps and abusive to those APIs. The Cardmarket rotation is a **Pokémon** mechanism (EN + CJK); scope it there. Add to `lib/prices/sync.test.ts`:

```ts
test('the Cardmarket rotation skips MTG/YGO cards (they are priced by their sweeps)', async () => {
  const [, mtg, ygo] = await db.insert(schema.cards).values([
    { name: 'Pika', game: 'pokemon', setName: 'X', setNumber: '1', externalId: 'p1' },
    { name: 'Bolt', game: 'mtg', language: 'EN', setName: 'Y', setNumber: '2', externalId: 'scryfall:b' },
    { name: 'DM', game: 'yugioh', language: 'EN', setName: 'Z', setNumber: '3', externalId: 'ygoprodeck:1:Z-3:C' },
  ]).returning()
  stubFetch({ cardmarket: { p1: { trend: 1, low: 1, avg: 1 } } })
  await syncStaleCardmarket({ ...SETTINGS, enabledGames: ['pokemon', 'mtg', 'yugioh'] }, {}, db)
  const priced = new Set((await db.select().from(schema.priceCache)).map(p => p.cardId))
  assert.ok(!priced.has(mtg.id)) // never a rotation candidate
  assert.ok(!priced.has(ygo.id))
})
```

Run → FAIL (MTG/YGO rows are picked up and priced). Then in `lib/prices/sync.ts`, add `eq(cards.game, 'pokemon')` to the `syncStaleCardmarket` candidate query's `and(...)` where-clause (a one-line addition; `eq` and `cards` are already imported). Run: `npx tsx --test lib/prices/sync.test.ts` → PASS. Then `npm test`, then `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add lib/sources/registry.ts lib/sources/registry.test.ts lib/apis/scryfall.ts lib/apis/ygoprodeck.ts lib/prices/sync.ts lib/prices/sync.test.ts
git commit -m "feat: source registry + per-card MTG/YGO price refresh; scope Cardmarket rotation to Pokémon"
```

---

### Task 7: Nightly orchestration — sweep enabled games under a budget

**Files:**
- Modify: `lib/prices/run-sync.ts`
- Modify: `lib/prices/run-sync.test.ts` (exists from phase 1 — extend)

**Interfaces:**
- Consumes: `sweepScryfall` (Task 5), `sweepYgoprodeck` (Task 5).
- Produces: `runFullPriceSync` result gains `scryfallSweep: SweepResult` and `ygoSweep: SweepResult`; `RunSyncDeps` gains `sweepScryfall?` and `sweepYgo?`.

- [ ] **Step 1: Extend the failing run-sync test**

Add to `lib/prices/run-sync.test.ts`:

```ts
test('nightly sync runs the MTG and YGO sweeps and reports each', async () => {
  const db = await createTestDb()
  const calls: string[] = []
  const noSweep = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  const result = await runFullPriceSync(db, {
    sweepTcgplayer: async () => { calls.push('en'); return { pagesFetched: 0, pagesFailed: 0, cardsSeen: 0, newCards: 0, pricesUpdated: 0 } },
    sweepTcgdex: async () => { calls.push('tcgdex'); return { setsChecked: 0, setsImported: 0, setsFailed: 0, cardsSeen: 0, newCards: 0 } },
    sweepScryfall: async () => { calls.push('mtg'); return noSweep },
    sweepYgo: async () => { calls.push('ygo'); return noSweep },
    syncInStock: async () => { calls.push('instock'); return { synced: 0, failed: 0 } },
    syncStale: async () => { calls.push('rotation'); return { synced: 0, failed: 0, remaining: 0 } },
    prune: async () => { calls.push('prune') },
  })
  assert.ok(calls.includes('mtg') && calls.includes('ygo'))
  assert.ok(result.scryfallSweep && result.ygoSweep)
})
```

Run: `npx tsx --test lib/prices/run-sync.test.ts` → FAIL.

- [ ] **Step 2: Extend `lib/prices/run-sync.ts`**

```ts
import { getSettings } from '@/lib/settings'
import { sweepTcgplayerCatalogue, syncInStockCardmarket, syncStaleCardmarket, pruneOldHistory } from '@/lib/prices/sync'
import { sweepTcgdexCatalogue } from '@/lib/prices/tcgdex-sweep'
import { sweepScryfall } from '@/lib/sources/scryfall-sweep'
import { sweepYgoprodeck } from '@/lib/sources/ygoprodeck-sweep'
import type { Db } from '@/lib/db'

interface RunSyncDeps {
  sweepTcgplayer?: typeof sweepTcgplayerCatalogue
  sweepTcgdex?: typeof sweepTcgdexCatalogue
  sweepScryfall?: typeof sweepScryfall
  sweepYgo?: typeof sweepYgoprodeck
  syncInStock?: typeof syncInStockCardmarket
  syncStale?: typeof syncStaleCardmarket
  prune?: typeof pruneOldHistory
}

// One tenant's full nightly refresh. Pokémon EN + CJK sweeps first (unchanged),
// then the other enabled games' catalogue sweeps (each internally a no-op when
// its game is disabled, and each self-bounded: MTG is page-budgeted/cursored,
// YGO is a single cheap call), then per-card in-stock sync, the stalest-first
// rotation, and history retention. Every sweep is independent, so a failing
// upstream for one game never blocks another.
export async function runFullPriceSync(db: Db, deps: RunSyncDeps = {}) {
  const settings = await getSettings(db)
  const sweep = await (deps.sweepTcgplayer ?? sweepTcgplayerCatalogue)(settings, {}, db)
  const tcgdexSweep = await (deps.sweepTcgdex ?? sweepTcgdexCatalogue)(settings, db)
  const scryfallSweep = await (deps.sweepScryfall ?? sweepScryfall)(settings, db)
  const ygoSweep = await (deps.sweepYgo ?? sweepYgoprodeck)(settings, db)
  const cardmarket = await (deps.syncInStock ?? syncInStockCardmarket)(settings, db)
  const cardmarketRotation = await (deps.syncStale ?? syncStaleCardmarket)(settings, {}, db)
  await (deps.prune ?? pruneOldHistory)(db)
  return { sweep, tcgdexSweep, scryfallSweep, ygoSweep, cardmarket, cardmarketRotation }
}
```

Run: `npx tsx --test lib/prices/run-sync.test.ts` → PASS. Then `npm test`.

- [ ] **Step 3: Commit**

```bash
git add lib/prices/run-sync.ts lib/prices/run-sync.test.ts
git commit -m "feat: nightly orchestration sweeps enabled MTG/YGO catalogues (self-bounded per game)"
```

---

### Task 8: Import script — MTG bulk import + YGO dump

**Files:**
- Modify: `scripts/import-catalogue.ts`
- Modify: `package.json` (add `stream-json` devDependency)
- Create: `lib/sources/scryfall-bulk.ts`, `lib/sources/scryfall-bulk.test.ts`

**Interfaces:**
- Consumes: `fetchScryfallBulkUri` (Task 3), `normalizeScryfallCard` (Task 3), `upsertNormalizedCards` (Task 5), `sweepYgoprodeck` (Task 5).
- Produces: `importScryfallBulk(settings, dbc?, deps?): Promise<SweepResult>` (from `@/lib/sources/scryfall-bulk`).

> The nightly sweep uses the paged API; the initial import streams the 557 MB `default_cards` bulk file instead (respecting Scryfall's "use bulk data for bulk" guidance and finishing in one pass). Both feed the same `upsertNormalizedCards`.

- [ ] **Step 1: Add the dependency**

```bash
npm install --save-dev stream-json
```

Expected: `package.json` devDependencies gains `stream-json`.

- [ ] **Step 2: Write the failing bulk-import test (injecting a fake object stream)**

`lib/sources/scryfall-bulk.test.ts` (test the streaming/normalisation seam with an injected async iterable — no 557 MB download):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { importScryfallBulk } from '@/lib/sources/scryfall-bulk'
import type { ScryfallCard } from '@/lib/apis/scryfall'

const objs: ScryfallCard[] = [
  { id: 'x', name: 'X', lang: 'en', set: 's', set_name: 'S', collector_number: '1', finishes: ['nonfoil'], games: ['paper'], prices: { usd: '1', eur: '1' } },
  { id: 'y', name: 'Y', lang: 'en', set: 's', set_name: 'S', collector_number: '2', finishes: ['nonfoil', 'foil'], games: ['paper'], prices: { usd: '1', usd_foil: '2', eur: '1', eur_foil: '2' } },
]
const settings = { ...DEFAULT_SETTINGS, enabledGames: ['pokemon' as const, 'mtg' as const] }

test('streams bulk objects into rows (foil printing splits into two)', async () => {
  const db = await createTestDb()
  const r = await importScryfallBulk(settings, db, { stream: async function* () { yield* objs } })
  assert.equal(r.newCards, 3) // x + y(nonfoil) + y(foil)
  assert.equal((await db.select().from(cards).where(eq(cards.game, 'mtg'))).length, 3)
})

test('no-op when mtg is not enabled', async () => {
  const db = await createTestDb()
  const r = await importScryfallBulk({ ...settings, enabledGames: ['pokemon'] }, db, { stream: async function* () { yield* objs } })
  assert.equal(r.cardsSeen, 0)
})
```

Run: `npx tsx --test lib/sources/scryfall-bulk.test.ts` → FAIL.

- [ ] **Step 3: Write `lib/sources/scryfall-bulk.ts`**

```ts
import { db, type Db } from '@/lib/db'
import { fetchScryfallBulkUri, normalizeScryfallCard, type ScryfallCard } from '@/lib/apis/scryfall'
import { chunked } from '@/lib/prices/sync'
import { upsertNormalizedCards, type SweepResult } from '@/lib/sources/upsert'
import type { AppSettings } from '@/lib/settings'

export interface ScryfallBulkDeps {
  // Async stream of raw card objects; defaults to streaming the live bulk file.
  stream?: () => AsyncIterable<ScryfallCard>
}

// Stream Scryfall's default_cards bulk file (557 MB) object-by-object, so peak
// memory stays flat. Used only by the off-cron import script.
async function* streamBulk(): AsyncIterable<ScryfallCard> {
  const { parser } = await import('stream-json')
  const { streamArray } = await import('stream-json/streamers/StreamArray')
  const uri = await fetchScryfallBulkUri()
  const res = await fetch(uri, { headers: { 'User-Agent': 'PokeDB/1.0 (github.com/pokedb)' } })
  if (!res.ok || !res.body) throw new Error(`Scryfall bulk download ${res.status}`)
  const { Readable } = await import('node:stream')
  const pipeline = Readable.fromWeb(res.body as never).pipe(parser()).pipe(streamArray())
  for await (const { value } of pipeline as AsyncIterable<{ value: ScryfallCard }>) yield value
}

// Full MTG import: every printing + prices in one streamed pass. Idempotent
// (shares upsertNormalizedCards). No-op unless MTG is enabled.
export async function importScryfallBulk(
  settings: AppSettings, dbc: Db = db, deps: ScryfallBulkDeps = {},
): Promise<SweepResult> {
  const result: SweepResult = { cardsSeen: 0, newCards: 0, pricesUpdated: 0, failed: 0 }
  if (!settings.enabledGames.includes('mtg')) return result
  const stream = deps.stream ?? streamBulk
  let buffer: ScryfallCard[] = []
  const flush = async () => { if (buffer.length) { await upsertNormalizedCards(dbc, buffer.flatMap(normalizeScryfallCard), settings, result); buffer = [] } }
  for await (const card of stream()) {
    buffer.push(card)
    if (buffer.length >= 500) await flush()
  }
  await flush()
  return result
}
```

Run: `npx tsx --test lib/sources/scryfall-bulk.test.ts` → PASS.

- [ ] **Step 4: Wire both into `scripts/import-catalogue.ts`**

After the existing TCGdex CJK sweep block, add the MTG + YGO passes. Add imports:

```ts
import { importScryfallBulk } from '../lib/sources/scryfall-bulk'
import { sweepYgoprodeck } from '../lib/sources/ygoprodeck-sweep'
```

and, after the CJK block (mirroring its logging + exit-code handling):

```ts
  if (settings.enabledGames.includes('mtg')) {
    const mtg = await importScryfallBulk(settings)
    console.log('Scryfall (MTG) import done:', mtg)
    if (mtg.failed > 0) process.exitCode = 1
  }
  if (settings.enabledGames.includes('yugioh')) {
    const ygo = await sweepYgoprodeck(settings)
    console.log('YGOPRODeck import done:', ygo)
    if (ygo.failed > 0) process.exitCode = 1
  }
```

- [ ] **Step 5: Lint + full tests**

Run: `npm run lint` and `npm test` → clean/green. (The script itself is exercised manually per tenant; the streaming logic is covered by the injected-stream test.)

- [ ] **Step 6: Commit**

```bash
git add scripts/import-catalogue.ts lib/sources/scryfall-bulk.ts lib/sources/scryfall-bulk.test.ts package.json package-lock.json
git commit -m "feat: import-catalogue imports MTG (streamed Scryfall bulk) + YGO dump, gated by enabledGames"
```

---

### Task 9: Game-first search — shared selector + POS/buylist/intake/wants

**Files:**
- Create: `lib/games-client.ts` **(only if needed)** — skip; `lib/games.ts` is already client-safe.
- Create: `components/shared/GameFilter.tsx`
- Create: `components/shared/useStickyGameFilter.ts`
- Modify: `lib/domain/inventory.ts` (`searchSellables` gains `game?`)
- Modify: `lib/domain/inventory.test.ts` (game-filter test)
- Modify: `app/api/inventory/route.ts` (parse `game` param → `searchSellables`)
- Modify: `app/(app)/pos/page.tsx` (render the selector beside `<SearchBar>`; append `&game=` to the `/api/inventory` fetch — `SearchBar.tsx` itself is unchanged)
- Modify: `app/(app)/buylist/page.tsx`, `components/inventory/AddItemForm.tsx`, `components/customers/CustomerDetail.tsx` (selector + `&game=` on `/api/cards/search`)
- Modify: `components/pos/CardResult.tsx` (game badge)

**Interfaces:**
- Consumes: `GAMES`, `GAME_IDS`, `type Game` (Task 1); `useSettings` (`enabledGames`).
- Produces: `type GameFilterValue = Game | 'all'`; `useStickyGameFilter(surface: string): [GameFilterValue, (v: GameFilterValue) => void]`; `<GameFilter value onChange />`; `searchSellables(q, dbc?, game?)`.

- [ ] **Step 1: Write the failing `searchSellables` game-filter test**

Add to `lib/domain/inventory.test.ts` (reuse its seed helpers; it already seeds Pokémon stock — add an MTG card + stock inline):

```ts
test('searchSellables scopes to a game when one is given', async () => {
  const dbc = await createTestDb()
  await seedBase(dbc)
  // one Pokémon and one MTG card, both named to match "bolt"/"jolt" style query
  const [pkmn] = await dbc.insert(schema.cards).values({ name: 'Voltorb Bolt', game: 'pokemon', setName: 'X', setNumber: '1', externalId: 'p1' }).returning()
  const [mtg] = await dbc.insert(schema.cards).values({ name: 'Lightning Bolt', game: 'mtg', language: 'EN', setName: 'Y', setNumber: '2', externalId: 'scryfall:b' }).returning()
  for (const c of [pkmn, mtg]) await dbc.insert(schema.inventoryItems).values({ cardId: c.id, condition: 'NM', quantity: 1, qrCode: `qr-${c.id}`, isActive: true })

  const all = await searchSellables('Bolt', dbc)
  assert.equal(all.length, 2)
  const onlyMtg = await searchSellables('Bolt', dbc, 'mtg')
  assert.equal(onlyMtg.length, 1)
  assert.equal(onlyMtg[0].card?.game, 'mtg')
})
```

(Add `schema`/`createTestDb`/`seedBase` imports if the file lacks them.) Run: `npx tsx --test lib/domain/inventory.test.ts` → FAIL (extra arg ignored, returns 2).

- [ ] **Step 2: Add the `game` param to `searchSellables`**

In `lib/domain/inventory.ts`, import the type and widen the signature + where-clause:

```ts
import { type Game } from '@/lib/games'
```

```ts
export async function searchSellables(q: string, dbc: Db = db, game?: Game) {
  const scope = game ? [eq(cards.game, game)] : []
  const base = () => dbc
    .select({ item: inventoryItems, card: cards, product: products, prices: priceCache })
    .from(inventoryItems)
    .leftJoin(cards, eq(inventoryItems.cardId, cards.id))
    .leftJoin(products, eq(inventoryItems.productId, products.id))
    .leftJoin(priceCache, eq(cards.id, priceCache.cardId))
  if (EAN_RE.test(q)) {
    const exact = await base().where(and(eq(inventoryItems.isActive, true), eq(products.ean, q)))
    if (exact.length > 0) return exact
  }
  return base().where(and(
    eq(inventoryItems.isActive, true),
    or(like(cards.name, `%${q}%`), like(cards.aliasName, `%${q}%`), like(products.name, `%${q}%`)),
    ...scope,
  ))
}
```

Run: `npx tsx --test lib/domain/inventory.test.ts` → PASS.

- [ ] **Step 3: Thread `game` through `/api/inventory`**

In `app/api/inventory/route.ts`, import `isGame` from `@/lib/games`, and in the `if (q)` branch pass the parsed game:

```ts
  if (q) {
    const gameParam = req.nextUrl.searchParams.get('game')
    const game = gameParam && isGame(gameParam) ? gameParam : undefined
    return respond(await searchSellables(q, db, game))
  }
```

- [ ] **Step 4: Write the sticky hook**

`components/shared/useStickyGameFilter.ts`:

```ts
'use client'
import { useEffect, useState } from 'react'
import { type Game } from '@/lib/games'

export type GameFilterValue = Game | 'all'

// A game selection that persists per surface for the browser session — a run
// of Magic buys stays on Magic without re-picking, but nothing leaks a hidden
// global mode across sessions. Starts on 'all'.
export function useStickyGameFilter(surface: string): [GameFilterValue, (v: GameFilterValue) => void] {
  const key = `pokedb:gameFilter:${surface}`
  const [value, setValue] = useState<GameFilterValue>('all')
  useEffect(() => {
    const stored = sessionStorage.getItem(key)
    if (stored) setValue(stored as GameFilterValue)
  }, [key])
  const set = (v: GameFilterValue) => {
    setValue(v)
    sessionStorage.setItem(key, v)
  }
  return [value, set]
}
```

- [ ] **Step 5: Write the selector component**

`components/shared/GameFilter.tsx`:

```tsx
'use client'
import { useSettings } from '@/components/shared/SettingsProvider'
import { GAMES, type Game } from '@/lib/games'
import type { GameFilterValue } from '@/components/shared/useStickyGameFilter'

// Game-first search scope. Single-select ("All games" or one game). Renders
// only when the shop has more than one game enabled, so single-game shops see
// no new chrome. Segmented buttons for a handful of games.
export function GameFilter({ value, onChange }: { value: GameFilterValue; onChange: (v: GameFilterValue) => void }) {
  const { enabledGames } = useSettings()
  if (enabledGames.length <= 1) return null
  const options: GameFilterValue[] = ['all', ...enabledGames]
  return (
    <div role="group" aria-label="Filter by game" className="inline-flex rounded-md border bg-muted p-0.5">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-sm rounded ${value === opt ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          {opt === 'all' ? 'All games' : GAMES[opt as Game].shortLabel}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Wire the selector into the four surfaces**

For each surface, add the hook + render `<GameFilter>` beside the search box, and append `&game=` to the fetch when the value isn't `'all'`. The edit is the same shape everywhere:

- **POS** (`app/(app)/pos/page.tsx`): add `const [gameFilter, setGameFilter] = useStickyGameFilter('pos')`; render `<GameFilter value={gameFilter} onChange={setGameFilter} />` next to `<SearchBar>` (line ~289); in the search fetch (line 127) change to:
  ```ts
  const gameQ = gameFilter !== 'all' ? `&game=${gameFilter}` : ''
  const res = await fetch(`/api/inventory?q=${encodeURIComponent(query)}${gameQ}`)
  ```
  (thread `gameFilter` into `handleSearch`'s dependency/closure.)
- **Buylist** (`app/(app)/buylist/page.tsx`, fetch line ~41): same hook (`'buylist'`), render the selector by its search input, append `${gameFilter !== 'all' ? \`&game=${gameFilter}\` : ''}` to the `/api/cards/search` URL.
- **Inventory add** (`components/inventory/AddItemForm.tsx`, fetch line ~71): hook (`'inventory-add'`), selector above the results, append the same `&game=`.
- **Customer wants** (`components/customers/CustomerDetail.tsx`, fetch line ~158): hook (`'customer-wants'`), selector by the want search box, append the same `&game=`.

- [ ] **Step 7: Add the game badge to results**

In `components/pos/CardResult.tsx`, import `GAMES, type Game` from `@/lib/games` and, next to the existing language badge (line ~140), add a game badge for non-Pokémon rows so an "All games" list is unambiguous:

```tsx
{card.game !== 'pokemon' && (
  <Badge variant="outline">{GAMES[card.game as Game]?.shortLabel ?? card.game}</Badge>
)}
```

- [ ] **Step 8: Verify in the browser**

Run the dev server (via the preview tool, not Bash). With `enabledGames` still `['pokemon']`, confirm no selector appears (no regression). Then temporarily set the settings row to `["pokemon","mtg"]` (or complete Task 11 first) and confirm the selector appears on POS/buylist/intake/wants and scopes results. Take a screenshot of the POS selector.

- [ ] **Step 9: Lint + tests + commit**

Run: `npm run lint`, `npm test` → green.

```bash
git add lib/domain/inventory.ts lib/domain/inventory.test.ts app/api/inventory/route.ts components/shared/GameFilter.tsx components/shared/useStickyGameFilter.ts app/\(app\)/pos/page.tsx app/\(app\)/buylist/page.tsx components/inventory/AddItemForm.tsx components/customers/CustomerDetail.tsx components/pos/CardResult.tsx
git commit -m "feat: game-first search selector (sticky per surface) on POS, buylist, intake, wants + game badge"
```

---

### Task 10: Catalogue browser game filter

**Files:**
- Modify: `lib/domain/catalogue.ts` (`getSets`, `getNames`, `getCardsInSet`, `getPrintingsByName` gain `game?`)
- Modify: `lib/domain/catalogue.test.ts` (game-scope assertions)
- Modify: `app/api/cards/sets/route.ts`, `app/api/cards/names/route.ts`, `app/api/cards/browse/route.ts`, `app/api/cards/browse-by-name/route.ts` (parse `?game=` and forward)
- Modify: `components/catalogue/CatalogueBrowser.tsx` (selector + thread `game`)

**Interfaces:**
- Consumes: `isGame`, `type Game` (Task 1); `GameFilter`, `useStickyGameFilter`, `GameFilterValue` (Task 9).
- Produces: `getSets(dbc?, game?)`, `getNames(q, dbc?, game?)`, `getCardsInSet(setName, dbc?, game?)`, `getPrintingsByName(name, dbc?, game?)` — each scoping on `cards.game` when `game` is given.

- [ ] **Step 1: Write failing scope tests**

Add to `lib/domain/catalogue.test.ts` (reuse its imports; add `createTestDb`/`schema` if absent):

```ts
test('catalogue queries scope to the requested game', async () => {
  const dbc = await createTestDb()
  await dbc.insert(schema.cards).values([
    { name: 'Alpha Bolt', game: 'pokemon', setName: 'Base Set', setNumber: '1', externalId: 'p1' },
    { name: 'Alpha Bolt', game: 'mtg', language: 'EN', setName: 'Alpha', setNumber: '1', externalId: 'scryfall:b' },
  ])
  const sets = await getSets(dbc, 'mtg')
  assert.ok(sets.some(s => s.setName === 'Alpha'))
  assert.ok(!sets.some(s => s.setName === 'Base Set'))
  assert.deepEqual(await getNames('Alpha', dbc, 'pokemon'), ['Alpha Bolt']) // one game's rows only
  assert.equal((await getCardsInSet('Alpha', dbc, 'pokemon')).length, 0)
  assert.equal((await getPrintingsByName('Alpha Bolt', dbc, 'mtg')).length, 1)
})
```

Run: `npx tsx --test lib/domain/catalogue.test.ts` → FAIL (extra arg ignored; MTG rows leak in).

- [ ] **Step 2: Add `game?: Game` to the four queries in `lib/domain/catalogue.ts`**

Import `type Game` from `@/lib/games`. For each function, add `game?: Game` as the trailing parameter and fold `...(game ? [eq(cards.game, game)] : [])` into an `and(...)` where-clause (matching the `searchCards` scope pattern). Concretely:

- `getSets(dbc: Db = db, game?: Game)` — the query has no `where` today; add `.where(game ? eq(cards.game, game) : undefined)` (Drizzle treats `undefined` as no filter).
- `getNames(q: string | undefined, dbc: Db = db, game?: Game)` — change `.where(like(cards.name, \`${q ?? ''}%\`))` to `.where(and(like(cards.name, \`${q ?? ''}%\`), ...(game ? [eq(cards.game, game)] : [])))`.
- `getCardsInSet(setName: string, dbc: Db = db, game?: Game)` — change `.where(eq(cards.setName, setName))` to `.where(and(eq(cards.setName, setName), ...(game ? [eq(cards.game, game)] : [])))`.
- `getPrintingsByName(name: string, dbc: Db = db, game?: Game)` — change `.where(eq(cards.name, name))` to `.where(and(eq(cards.name, name), ...(game ? [eq(cards.game, game)] : [])))`.

(Ensure `and` is imported from `drizzle-orm` in this file.) Run: `npx tsx --test lib/domain/catalogue.test.ts` → PASS.

- [ ] **Step 3: Parse `game` in the four routes**

In each of `app/api/cards/{sets,names,browse,browse-by-name}/route.ts`, import `isGame` from `@/lib/games`, add `const g = req.nextUrl.searchParams.get('game'); const game = g && isGame(g) ? g : undefined`, and pass `game` as the trailing argument to `getSets`/`getNames`/`getCardsInSet`/`getPrintingsByName`. (`sets/route.ts`'s handler currently takes no `req` — change it to `guarded(async (req: NextRequest) => {…})` to read the param.) Keep `guarded()`.

- [ ] **Step 5: Wire the selector into `CatalogueBrowser.tsx`**

Add `const [gameFilter, setGameFilter] = useStickyGameFilter('catalogue')`, render `<GameFilter value={gameFilter} onChange={setGameFilter} />` above the mode toggle, and append `${gameFilter !== 'all' ? \`&game=${gameFilter}\` : ''}` to all four fetches (`/api/cards/sets`, `/names`, `/browse`, `/browse-by-name`). Add `gameFilter` to the effect dependency arrays so switching game re-loads sets/names.

- [ ] **Step 6: Verify + lint + tests + commit**

Browser-verify (Task 9 step 8 pattern) that the catalogue browser's set/name lists change with the selector. Run `npm run lint`, `npm test`.

```bash
git add app/api/cards components/catalogue/CatalogueBrowser.tsx lib/domain
git commit -m "feat: catalogue browser game filter (sets/names/browse endpoints game-scoped)"
```

---

### Task 11: Settings — enable/disable games (gated) + server enforcement

**Files:**
- Modify: `app/api/settings/route.ts` (enforce `multiGame` on `enabledGames` writes)
- Modify: `lib/entitlements.test.ts` **or** a new `lib/domain/settings-gating.test.ts` (enforcement unit test — see step 2)
- Modify: `components/settings/SettingsForm.tsx` (games enable/disable UI)

**Interfaces:**
- Consumes: `getEntitlements()` from `@/lib/entitlements` (returns `Promise<Entitlements>`; single-tenant → `entitlementsFor('pro')`, so `multiGame: true`); `Entitlements.multiGame` (Task 1); `GAMES`, `GAME_IDS` (Task 1); `settingsPatchSchema` (validates `enabledGames`, Task 1).
- Produces: a settings PATCH that sets `enabledGames.length > 1` is rejected `403` unless the tenant's entitlements have `multiGame: true`. The enforcement lives in a small pure guard so it is unit-testable without HTTP.

> Pattern reference: `app/api/staff/route.ts` enforces the seat limit via `assertStaffSeatAvailable(await getEntitlements(), db)` (a domain guard that throws `DomainError`, mapped to a status by `guarded()`). Mirror that shape.

- [ ] **Step 1: Write the pure predicate + its failing test**

`lib/plan.ts` is client-imported (`BillingCard.tsx`, `SignupForm.tsx`), so keep it a pure, declarative predicate — no error class, no DB. Test first, in `lib/plan.test.ts`:

```ts
import { gamesAllowed } from '@/lib/plan'

test('gamesAllowed: a second game needs multiGame; pokemon-only is always fine', () => {
  assert.equal(gamesAllowed(PLANS.starter.entitlements, ['pokemon', 'mtg']), false)
  assert.equal(gamesAllowed(PLANS.starter.entitlements, ['pokemon']), true)
  assert.equal(gamesAllowed(PLANS.growth.entitlements, ['pokemon', 'mtg', 'yugioh']), true)
})
```

Run: `npx tsx --test lib/plan.test.ts` → FAIL.

- [ ] **Step 2: Implement the predicate**

In `lib/plan.ts` add (import only the game type — `lib/games.ts` is dependency-free, so this stays client-safe):

```ts
import { type Game } from '@/lib/games'

// A tenant may enable more than one game only with the multiGame entitlement.
// Pure/declarative so the client (SettingsForm) can grey out the toggle and
// the server (settings route) can reject the write with the same rule.
export function gamesAllowed(ent: Entitlements, enabledGames: Game[]): boolean {
  return enabledGames.length <= 1 || ent.multiGame
}
```

Run: `npx tsx --test lib/plan.test.ts` → PASS.

- [ ] **Step 3: Enforce in the settings route**

In `app/api/settings/route.ts`, import `getEntitlements` from `@/lib/entitlements` and `gamesAllowed` from `@/lib/plan`, and in `PATCH` after `parseBody`:

```ts
  const patch = await parseBody(req, settingsPatchSchema)
  if (patch.enabledGames && !gamesAllowed(await getEntitlements(), patch.enabledGames)) {
    return NextResponse.json({ error: 'Multiple games require the Growth plan' }, { status: 403 })
  }
  return NextResponse.json(await updateSettings(patch, db))
```

(Single-tenant `getEntitlements()` returns full `pro` entitlements, so this is a no-op for tests/e2e/Wizard-of-Oz.) Add a route test in the settings route's test file mirroring the staff-route gated tests: a `multiGame:false` context (multi-tenant `x-tenant-entitlements` header) → `403`; pokemon-only → `200`. Run the relevant test files → PASS.

- [ ] **Step 3b: Use the same predicate in the UI (Step 4 wires it)** — `SettingsForm` greys out the non-Pokémon game checkboxes with `!gamesAllowed(entitlements, [...])`, so the client and server agree on the rule.

- [ ] **Step 4: Add the games toggle to `SettingsForm.tsx`**

Mirror the existing `enabledLanguages` control (phase 1). Render a checkbox per `GAME_IDS` (label `GAMES[g].label`), `pokemon` checked+disabled (always on), the rest toggled into `enabledGames`. When the tenant lacks `multiGame`, disable the non-Pokémon checkboxes and show a one-line "Growth plan" hint (reuse the plan-gating UI pattern used elsewhere). PATCH `enabledGames` on save with the rest of settings.

- [ ] **Step 5: Verify in the browser**

Browser-verify: as a full-entitlement (single-tenant) shop, enable Magic + Yu-Gi-Oh! in Settings, confirm the save persists and the game selector (Task 9) now appears on the search surfaces. Screenshot the settings games control.

- [ ] **Step 6: Lint + tests + commit**

Run `npm run lint`, `npm test`.

```bash
git add app/api/settings components/settings/SettingsForm.tsx
git commit -m "feat: settings games enable/disable, multiGame enforced server-side"
```

---

### Task 12: End-to-end + migration verification + docs

**Files:**
- Modify: `tests/e2e/` (add a multi-game checkout spec, matching the existing checkout smoke test's shape)
- Modify: `AGENTS.md` (note MTG/YGO in the stack/scripts section if warranted)
- Reference: `docs/runbooks/wizard-of-oz-shop-deploy.md` (per-tenant enable + import step)

**Interfaces:**
- Consumes: everything above (end-to-end).

- [ ] **Step 1: Migration verification on a fresh DB**

Confirm the additive migration applies cleanly and existing data is untouched:

```bash
npx tsx -e "import { createTestDb } from './lib/db/test-helpers'; import { sql } from 'drizzle-orm'; const db = await createTestDb(); const r = await db.get(sql\`SELECT COUNT(*) n FROM cards WHERE game != 'pokemon'\`); console.log('non-pokemon rows on fresh DB:', r); const s = await db.get(sql\`SELECT enabled_games FROM settings WHERE id = 1\`); console.log('enabled_games default:', s)"
```

Expected: `0` non-pokemon rows; `enabled_games` reads `["pokemon"]` once a settings row exists. (Confirms the backfill "verification, not rewrite" claim from spec §7.)

- [ ] **Step 2: Write the multi-game checkout e2e**

Add an e2e spec that seeds one MTG **foil** card + one YGO printing with prices, enables both games (seed `enabled_games = '["pokemon","mtg","yugioh"]'` in the throwaway DB), then drives the POS: pick the game in the selector, search, add to cart, check out. Assert the sale total reflects each card's priced value. Follow `test:e2e`'s existing seeding/model exactly (see the checkout smoke test); mind the two env gotchas in AGENTS.md (`.env.local` override, `$` escaping).

Run: `npm run test:e2e` (first run in a cold worktree may be a throwaway cache-warmer — rerun warm before diagnosing, per the e2e cold-worktree note).

- [ ] **Step 3: Docs**

If `AGENTS.md`'s scripts/stack section would mislead a future agent without it, add a line noting MTG (Scryfall) and YGO (YGOPRODeck) singles and the `enabledGames` gate. Note in the Wizard-of-Oz runbook that enabling a new game requires re-running `scripts/import-catalogue.ts` for that tenant (mirrors the phase-1 CJK note).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e AGENTS.md docs/runbooks
git commit -m "test: multi-game checkout e2e + migration verification; docs for MTG/YGO enablement"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** every spec section maps to a task — metadata/settings/entitlement + migration (§1 → T1), external ids/registry (§2 → T2, T6), Scryfall adapter (§3 → T3, T5, T8), YGOPRODeck adapter (§4 → T4, T5), bounded sync + cursor + orchestration (§5 → T5, T7, T8), game-first search UI across all five surfaces (§6 → T9, T10), gating (§4/§1 → T11), migration/backfill (§7 → T1, T12), testing (§8 → every task + T12).
- **Type consistency:** `NormalizedCard`/`NormalizedPrices` (T3) are consumed unchanged by T5/T6/T8; `SweepResult` shape is fixed in T5 and reused in T6/T7/T8; `syncMarketPricesForCard`'s signature is unchanged (T6 adds an internal branch only); `GameFilterValue` (T9) is reused in T10.
- **Three implementation refinements over the spec:** (a) the nightly MTG sweep uses Scryfall's **paged search API** with a page cursor rather than downloading the 557 MB bulk file nightly — the bulk file is used only by the import script (T8), exactly as spec §5 intends; (b) Pokémon stays on its existing sweep path and is intentionally **absent** from `CATALOGUE_SOURCES` (the registry drives only the new games), so phase-1 behaviour is untouched (regression-guarded in T2/T6); (c) the per-card Cardmarket **rotation is scoped to `game = 'pokemon'`** (T6 step 6) — MTG/YGO prices come from their sweeps, not a per-card Cardmarket crawl, so they must not enter that rotation (they would otherwise dominate it via their null `cardmarketSyncedAt` and hammer Scryfall/YGO one card at a time). Their per-card refresh is reserved for the bounded in-stock sync and on-demand search paths.
- **Verified against the codebase while writing:** entitlement resolution is `getEntitlements()` from `@/lib/entitlements` (single-tenant → full `pro`), enforcement mirrors `assertStaffSeatAvailable` (T11); the catalogue browse queries are `getSets`/`getNames`/`getCardsInSet`/`getPrintingsByName` in `lib/domain/catalogue.ts` (T10); `guarded()` maps `DomainError` → status; `searchSellables` already joins `cards`; `pickMarketSource` already falls back and treats 0 as no-data. The only genuinely open detail for the implementer is whether `lib/domain/errors.ts` is DB-free enough to import into client-safe `lib/plan.ts` (T11 step 2 gives a boolean fallback if not).
