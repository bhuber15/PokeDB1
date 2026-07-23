# Multi-game phase 2 — Magic + Yu-Gi-Oh! singles — design

Status: approved brainstorm with Brad, 2026-07-23. Builds directly on the approved umbrella
spec `2026-07-22-multi-game-multi-language-catalogue-design.md` (its §6 named this as "Phase 2
— multi-game machinery + easy games: MTG (Scryfall) and Yu-Gi-Oh! (YGOPRODeck)"). Phase 1
(multi-language Pokémon, PR #37) shipped the seams this plugs into; this spec activates a
second and third **game**.

Source ask (first-shop demo 2026-07-22): the shop sells Magic, Yu-Gi-Oh!, Lorcana, One Piece
and Topps/Panini alongside Pokémon. Languages shipped first because that was costing them
sales. Magic and Yu-Gi-Oh! are the two easiest next games (free, key-less bulk data carrying
both marketplaces), so they go together here. Lorcana / One Piece / manual sports cards stay
**phase 3**, out of scope for this spec.

## Decisions made in this brainstorm

1. **One plan, one PR:** the shared multi-game machinery (game metadata, `enabledGames`
   setting, `multiGame` entitlement, source registry, game-filter UI, bounded sweep cursor)
   plus both adapters ship together. The machinery is small and both games need all of it.
2. **Yu-Gi-Oh! identity is per-printing.** One `cards` row per `(passcode × set_code ×
   rarity)`, not per card. A shop selling singles prices a 1st-edition ultra rare and a common
   reprint of the same card completely differently — collapsing them to one row would quote the
   wrong price at the counter. This is the umbrella spec's identity rule ("a differently-priced
   printing is its own card") applied to rarity the way phase 1 applied it to language.
3. **Magic foils are their own rows.** A printing available in both finishes becomes two rows
   (nonfoil + foil), each priced from its own Scryfall field (`usd`/`eur` vs
   `usd_foil`/`eur_foil`). Correct foil pricing out of the box, chosen over row-count economy —
   the same "prioritise pricing correctness" call as decision 2.
4. **Search is game-first, via a per-surface sticky selector.** Every place staff search for a
   card gets a single-select game control ("All games" or exactly one game) beside the search
   box. It defaults to "All", remembers the last pick for the session per surface, and only
   appears once more than one game is enabled. No global/hidden active-game mode — a forgotten
   setting must never silently hide another game's cards.
5. **Multi-game is Growth+.** New `multiGame` entitlement (Starter false, Growth/Pro true),
   enforced server-side at the settings write. `enabledGames` defaults to `['pokemon']`.
   Single-tenant / Wizard-of-Oz deploys keep full entitlements (the `TENANCY_MODE`-unset path).
   Consistent with the umbrella spec §4; languages stay ungated.

## Current state this builds on (verified in-repo, 2026-07-23)

- `cards.game` / `cards.language` are live columns (defaults `'pokemon'` / `'EN'`); phase 1
  activated them through import → search → POS. `cards.aliasName` and the `(game, language)`
  index exist (migration 0021/0022).
- **`searchCards(q, db, deps, filters)` already accepts `{ game?, language? }`** and scopes
  every stage on `cards.game` / `cards.language` (`lib/domain/card-search.ts`). `GET
  /api/cards/search` already parses and forwards `game`/`language` query params. The search
  backend is ready; phase 2 adds the front-of-house control and more game values.
- **`syncMarketPricesForCard` already dispatches on `parseExternalId(externalId).source`**
  (`lib/prices/sync.ts`) — `tcgdex` vs the pokemontcg.io default. New sources slot in as new
  branches / registry entries.
- **`pickMarketSource` / `pickMarketPrice` already fall back** to the other marketplace when
  the primary is missing, and treat a cached `0` as no-data (`lib/pricing.ts`). So MTG's
  market-only rows and YGO's null-Cardmarket printings price correctly with **no `price_cache`
  changes** — every planned field maps onto the existing `tcgplayer_*` / `cardmarket_*` columns.
- `enabledGames`, `multiGame`, and any per-game metadata beyond a bare `GAME_IDS = ['pokemon']`
  do **not** exist yet — all new here.
- The nightly single-tenant cron is `GET /api/cron/sync-prices` → `runFullPriceSync`,
  `maxDuration = 300`, `0 3 * * *`. Multi-tenant syncs via the cursor-staggered `sync-tenants`
  fanout. The paged EN catalogue sweep (`sweepTcgplayerCatalogue`) is already page-budgeted
  (`maxPages`), the model phase-2 MTG paging follows.

## 1. Game metadata & settings

**`lib/games.ts`** grows from a bare id list into per-game metadata (still dependency-free —
client badges/filters import it; it must never drag `lib/db` into the browser bundle):

```ts
export const GAME_IDS = ['pokemon', 'mtg', 'yugioh'] as const
export type Game = (typeof GAME_IDS)[number]

export interface GameMeta {
  id: Game
  label: string          // "Magic: The Gathering"
  shortLabel: string     // "Magic" — badges/chips
  hasCatalogue: boolean  // false is reserved for phase-3 manual games (Topps/Panini)
  languages: Language[]  // phase 2: MTG/YGO are ['EN']; Pokémon keeps all five
}
export const GAMES: Record<Game, GameMeta> = { … }
export function isGame(x: unknown): x is Game { … }
```

Language stays a Pokémon concept in phase 2 (MTG/YGO are EN-only); `GameMeta.languages` records
that so search/UI never offers a JA filter for Magic.

**`enabledGames` setting** mirrors phase 1's `enabledLanguages` exactly:

- New `settings.enabled_games text not null default '["pokemon"]'` (JSON array of `Game`).
- `AppSettings.enabledGames: Game[]`; `parseGames()` tolerates junk (→ `['pokemon']`) and
  guarantees `'pokemon'` membership (the baseline game can't be disabled), symmetric with
  `parseLanguages()`. `toRow()` serialises it; `settingsPatchSchema` validates
  `z.array(z.enum(GAME_IDS)).transform(g => [...new Set(['pokemon', ...g])])`.
- Gates **import** (sweeps/rotation only touch enabled games — Turso row + cron-time hygiene),
  **search defaults**, and **UI chrome** (selector, badges). Disabling a game keeps its rows and
  stock but stops syncing and surfacing them.

**`multiGame` entitlement** in `lib/plan.ts`:

- Add `multiGame: boolean` to `Entitlements`; Starter `false`, Growth/Pro `true`.
- Enforced at the settings write: a PATCH that would set `enabledGames.length > 1` on a tenant
  whose entitlements have `multiGame: false` is rejected (`DomainError` / 403). `pokemon`-only
  writes always pass. Single-tenant (`TENANCY_MODE` unset) short-circuits to full entitlements,
  so tests / e2e / Wizard-of-Oz shops are unaffected.

## 2. Source registry & adapters

Formalise the umbrella spec's approach-A `CatalogueSource` (today the dispatch is a hardcoded
`if/else` in `syncMarketPricesForCard` and the sweeps are hardcoded in `run-sync`). New
`lib/sources/registry.ts`:

```ts
interface CatalogueSource {
  game: Game
  languages: Language[]
  // Bounded, idempotent catalogue+price sweep. `budget` caps work per nightly
  // run; `cursor` resumes where the last run stopped; returns the next cursor.
  sweep(ctx: SweepCtx): Promise<SweepOutcome>
  // Optional per-card refresh for the in-stock sync + on-demand search refresh
  // (small N, latency-sensitive). Keyed off the row's external id.
  refreshPrices?(externalId: string, ctx: RefreshCtx): Promise<void>
}
```

- **Exactly one catalogue-writing adapter per `(game, language)`** — cross-source duplicates
  are impossible by construction. Existing behaviour moves behind the registry unchanged:
  `pokemon/EN` → the pokemontcg.io sweep; `pokemon/{JA,KO,ZH-*}` → the TCGdex sweep + per-card
  rotation. New: `mtg/EN` → Scryfall; `yugioh/EN` → YGOPRODeck.
- `NormalizedCard` carries identity fields + **native-currency** prices; GBP conversion stays in
  the sync layer at the shop's rates (money stays integer pence, prices stay server-canonical).
- `runFullPriceSync` iterates `enabledGames`' adapters within a shared per-run budget (see §5);
  `syncMarketPricesForCard` consults the registry to route a per-card refresh to the right
  adapter.

**`external_id` conventions** (extending the phase-1 source-qualified scheme; bare ids stay
grandfathered pokemontcg.io EN, never rewritten):

| Game | Format | Example |
|---|---|---|
| MTG nonfoil | `scryfall:<uuid>` | `scryfall:4cbc6901-…-7eefa3b35021` |
| MTG foil / etched | `scryfall:<uuid>:foil` / `:etched` | `scryfall:…:foil` |
| Yu-Gi-Oh! printing | `ygoprodeck:<passcode>:<set_code>:<rarity_slug>` | `ygoprodeck:46986414:CT13-EN003:UR` |

`parseExternalId` gains `scryfall` and `ygoprodeck` variants; its unrecognised-prefix fallback
to `pokemontcg` is unchanged. `rarity_slug` = `set_rarity_code` stripped to alphanumerics
(fallback: a slug of `set_rarity`) so the parens in `(UR)` never reach an id.

## 3. Magic — Scryfall adapter (`lib/sources/scryfall.ts`)

Source facts verified live 2026-07-23 (`api.scryfall.com`, no API key — a `User-Agent` +
`Accept: application/json` header is required or the CDN 403s):

- **Bulk file `default_cards`** — one object per printing in English (or the only printed
  language). `557.9 MB`, refreshed ~daily, plain CDN JSON at `data.scryfall.io` (uri obtained
  from `GET /bulk-data/default-cards`). One entry per printing (`set` + `collector_number`).
- **Paged search** `GET /cards/search?q=game:paper lang:en&unique=prints` — 175 objects/page,
  full card objects (prices embedded), for the bounded nightly refresh.
- **Identity per object:** `id` (uuid, per printing), `set` (code), `set_name`,
  `collector_number`, `name`, `rarity`, `finishes` (`['nonfoil'|'foil'|'etched']`), `games`
  (filter to those including `'paper'`), `image_uris.{small,normal,large}`.
- **Prices:** `{ usd, usd_foil, usd_etched, eur, eur_foil, tix }` — strings or null. `usd` **is**
  TCGplayer USD, `eur` **is** Cardmarket EUR.

**Normalization (one row per printing per finish — decision 3):**

- For each `finish ∈ finishes` (paper only), emit a row: `game='mtg'`, `language='EN'`,
  `setName=set_name`, `setNumber=collector_number`, `variant` = `''`(nonfoil) / `'Foil'` /
  `'Etched'`, `series=set` (the set code), `externalId` per the table above, images from
  `image_uris`.
- **Price → `price_cache` (native → pence at shop rates):** nonfoil `usd→tcgplayerMarket`,
  `eur→cardmarketTrend`; foil `usd_foil`/`eur_foil`; etched `usd_etched→tcgplayerMarket`,
  Cardmarket left null (Scryfall has no `eur_etched`). `null`/`0` → the no-price workflow.
  Scryfall quotes a single market number per finish (no low/mid/high), so `tcgplayer_low/mid/
  high` and `cardmarket_low/avg` stay null — `pickMarketSource` already handles market-only rows.
- `isHighValue` set from the market price vs the shop threshold, as the EN sweep does.

## 4. Yu-Gi-Oh! — YGOPRODeck adapter (`lib/sources/ygoprodeck.ts`)

Source facts verified live 2026-07-23 (`db.ygoprodeck.com/api/v7/cardinfo.php`, no key):

- **One call, whole game.** No-param `cardinfo.php` returns all **14,471 cards → 44,004
  printings** (`card_sets` rows), a few MB. Cheap enough to refresh fully every night.
- **Per printing (`card_sets[]`):** `set_name`, `set_code` (e.g. `CT13-EN003`), `set_rarity`,
  `set_rarity_code` (e.g. `(UR)`), `set_price` (numeric **USD** string).
- **Per card:** `id` (passcode), `name`, `type`; `card_images[]` (`image_url`,
  `image_url_small`); `card_prices[0]` = `{ cardmarket_price (EUR), tcgplayer_price (USD), … }`
  — a **card-level aggregate**, not per printing.

**Normalization (one row per printing — decision 2):**

- For each `card_sets[]` entry: `game='yugioh'`, `language='EN'`, `name`, `setName=set_name`,
  `setNumber=set_code`, `variant=set_rarity`, `series=set_name`, `externalId=ygoprodeck:<passcode>:<set_code>:<rarity_slug>`,
  image from `card_images[0]`.
- **Price:** each printing's `set_price` (USD) → `tcgplayerMarket`. **Cardmarket left null per
  printing** — YGOPRODeck's only EUR figure is the card-level aggregate, which would be wrong on
  a rare printing (e.g. €0.02 on a £100 card), so we don't fake it. A Cardmarket-primary shop
  falls back to the tcgplayer-derived GBP automatically via `pickMarketSource`. `set_price`
  `'0.00'` → no-price workflow.
- YGO's whole catalogue is one request, so its adapter `sweep` ignores the page budget and
  simply upserts everything each night; a `refreshPrices` per-card branch is optional (the
  nightly full refresh already keeps stocked cards current).

## 5. Bounded nightly sync (the 557 MB problem) & orchestration

Downloading 557 MB in the nightly Vercel function (300 s, constrained memory) is unsafe. Split
by cadence, reusing the existing page-budget shape:

- **Initial import — off-cron.** `scripts/import-catalogue.ts` gains an MTG pass that
  stream-parses the Scryfall `default_cards` bulk file (memory-safe incremental JSON) and a YGO
  pass that pulls the one dump, upserting all rows + prices. Runs manually / locally with room
  to breathe, exactly like phase 1's `--full-prices`. A `--full` (or per-game) flag runs the
  MTG paged refresh to completion instead of trickling.
- **Nightly refresh — bounded.** YGO: the one dump, in full (cheap). MTG: the **paged search
  API** with a **per-run page budget + persisted cursor**, so a fixed slice of the catalogue
  refreshes each night and the full catalogue cycles over ~2 weeks. Stocked and just-searched
  MTG cards stay current regardless via the existing in-stock sync + on-demand refresh
  (`refreshStaleCardmarket`), generalised to dispatch to the Scryfall per-card branch.
- **Cursor persistence:** a small additive `catalogue_sync_state` table
  `(game text primary key, cursor text, updated_at text)` — off `settings` so operational sync
  state never mixes with shop config, and phase-3 games slot in. The MTG adapter stores its next
  page there; YGO doesn't need it.
- **Orchestration:** `runFullPriceSync` runs each enabled game's adapter `sweep` under one
  shared per-run budget (round-robin so no game starves another or overruns the cron window),
  then the in-stock sync, the per-card rotation (now source-dispatched), and history prune. The
  multi-tenant `sync-tenants` fanout is unchanged; per-tenant work stays proportional to enabled
  games.

## 6. Search UI — game-first selector (decision 4)

The umbrella spec's "unified search box + badges, not per-game tabs" holds; phase 2 adds one
primary scoping control. A shared `components/shared/GameFilter.tsx` (single-select: "All games"
or one enabled game) sits beside the search box on **all five surfaces**:

- POS till (`components/pos/SearchBar.tsx`), buylist (`app/(app)/buylist/page.tsx`), inventory
  add (`components/inventory/AddItemForm.tsx`), catalogue (`components/catalogue/CatalogueBrowser.tsx`),
  customer wants (`components/customers/CustomerDetail.tsx`).

Behaviour:

- **Sticky per surface, session-scoped.** A `useStickyGameFilter(surface)` hook backs the value
  with `sessionStorage` (key `pokedb:gameFilter:<surface>`), default `'all'`. A run of Magic
  buys stays on Magic without re-picking; nothing persists a hidden global mode across sessions.
- **Rendered only when `enabledGames.length > 1`** — single-game shops see today's UI unchanged.
  Segmented control for ≤4 games, a `Select` beyond that.
- Passes `game` to `/api/cards/search` (`'all'` → omit the param — backend already handles this).
- **Results badges:** a game badge joins the phase-1 language badge, so an "All games" result
  set is never ambiguous. Language stays implicit/badged (all enabled languages searched), not a
  second selector — MTG/YGO are EN-only, and Pokémon language disambiguation is already covered
  by badges.

## 7. Migration & backfill

Additive-only, deploy-order-safe (old code runs against the new schema):

1. Drizzle migration: `settings.enabled_games` (default `'["pokemon"]'`), the
   `catalogue_sync_state` table. No changes to `cards` or `price_cache`.
2. Backfill is a verification, not a rewrite: every existing row is already `game='pokemon'`,
   so there is nothing to migrate in `cards` — assert `count(*) FROM cards WHERE game != 'pokemon'`
   is 0 on existing DBs. No external ids rewritten.
3. Applying migrations to live tenant DBs stays a user-run step (migration/deploy gotcha
   runbook); the dev-boot drift guard catches lag.
4. First MTG/YGO catalogue load is the off-cron import script, run per tenant that enables the
   game.

## 8. Testing

- **Adapter unit tests** (pattern: `pokemon-tcg.test.ts`): fixture JSON → normalized rows.
  Scryfall: a both-finishes printing → two rows with the right per-finish prices; paper-only
  filter; null/0 prices → no-price. YGOPRODeck: a multi-printing card (e.g. Dark Magician's many
  set/rarity rows) → one row each with `set_price` mapped and Cardmarket null; `0.00` → no-price.
- **Registry / dispatch:** `parseExternalId` for the new id formats; the per-card rotation and
  on-demand refresh route MTG/YGO ids to the right adapter; the pokemontcg.io and TCGdex paths
  are byte-for-byte unchanged (regression guard).
- **Enablement & gating:** import skips disabled games; a Starter tenant is blocked from
  enabling a second game; single-tenant keeps full entitlements.
- **Sweep budget:** the MTG paged sweep respects its page budget and advances/persists its
  cursor; combined nightly run stays within budget.
- **Search:** game-filtered search returns only that game; `'all'` returns every enabled game;
  the selector is absent with one game enabled.
- **E2E:** sell an MTG **foil** single and a YGO **printing** through the till (both exercising
  the price path; a `set_price`-less YGO printing exercises the till quick-set from phase 1).
- New/changed routes keep `guarded()` + `parseBody()` + `getTenantDb()` (tenancy-guard test
  enforces).

## Out of scope (phase 3+, on record)

- Lorcana (Lorcast) and One Piece (TCGCSV) — long-tail games, own plan; re-verify their
  endpoint/field shapes at that plan's writing time.
- Manual games (Topps/Panini): `hasCatalogue: false`, free-text entry, override-only pricing —
  the `hasCatalogue` flag is introduced here but no manual game is wired.
- Non-EN languages for MTG/YGO.
- MTG etched-foil Cardmarket pricing (no `eur_etched` upstream) and a per-printing Cardmarket
  figure for Yu-Gi-Oh! (no honest source).
- Online listings sync for the new games (rides the online-sales-channel stub).
- Precise low/mid/high spreads for MTG (Scryfall quotes a single market number per finish).
