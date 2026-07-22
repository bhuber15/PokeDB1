# Multi-game + multi-language catalogue — design

Status: approved (brainstorm with Brad, 2026-07-22). Supersedes the open questions in
`2026-07-22-multi-game-multi-language-catalogue-stub.md`.

Source ask (first-shop demo 2026-07-22): sell Chinese/Japanese/Korean Pokémon singles, plus
Disney Lorcana, One Piece, Magic: The Gathering, Yu-Gi-Oh!, and Topps/Panini. This is the
"phase 2 multi-game singles" spec deliberately deferred by products phase 1 (PR #32) —
products already cover sealed/accessories for any game; this spec is **singles**.

## Decisions made in the brainstorm

1. **JP/KO/ZH Pokémon ships first** (phase 1). The shop's day-one gap; also the smallest new
   surface (TCGdex, which we already use, carries the CJK catalogues).
2. **A different-language printing is a differently-priced card.** Same artwork, different
   market price — so language is part of card identity (own `cards` row, own `price_cache`
   row), never a display attribute on inventory.
3. **No-price stock: intake nudge + till quick-set.** Intake flags "no market data — set
   your price" without blocking; the POS can set a persisting override at the till; buylist
   offers go manual with a visible no-anchor banner. `createSale`'s `NO_PRICE` guard stays
   the enforcement point.
4. **Source architecture: per-game adapters** (approach A). One `CatalogueSource` per
   (game, language-group), best source per game. Rejected: TCGCSV-only pipe (loses
   Cardmarket EUR, no KO/ZH, romanized JP names) and JustTCG (recurring per-tenant cost,
   single vendor). TCGCSV/JustTCG remain candidates as *individual adapters* for gap games.
5. **Plan gating: multi-game is Growth+.** New `multiGame` entitlement — false on Starter,
   true on Growth/Pro (wiki: the multi-game LGS segment pays £100–200/mo and Growth is the
   target tier). **Languages are ungated on every tier.** Single-tenant deploys get full
   entitlements; the pilot shop uses `entitlement_overrides` if ever needed.
6. Scope calls: other games ship **EN-only** first; all four CJK variants (ja, ko, zh-cn,
   zh-tw) arrive together behind a per-tenant language setting; search stays **unified**
   (one box) with filters, not per-game tabs.

## Current state this builds on (verified in-repo)

- `cards.game` and `cards.language` have existed since migration 0000 as dormant defaults
  (`'pokemon'`, `'EN'`). Nothing reads or filters them; import hardcodes `game: 'pokemon'`.
  The work is **activating** these columns through import → search → pricing → POS, not a
  schema redesign. Existing rows are already correct.
- `price_cache` columns are per-marketplace (`tcgplayer*` USD-derived, `cardmarket*`
  EUR-derived) and generalize as-is: every planned source feeds one or both families.
- POS already blocks priceless sales (`NO_PRICE` DomainError, disabled Add button); the
  price-age badge (PR #33) already covers stale-price honesty.
- The nightly Cardmarket rotation (`syncStaleCardmarket`) is per-card, budgeted (2,000
  cards / 60s per night), stalest-first — exactly the machinery per-card TCGdex pricing
  needs, currently hardcoded to one fetcher.

## 1. Card identity & schema

**Identity rule:** one `cards` row = one printing in one language of one game:
`(game, language, setName, setNumber, variant)`. No translation-linking table — selling,
buying, and pricing never need it.

Schema changes (one additive migration):

- **`cards.alias_name` (nullable text), new.** CJK findability: JP-exclusive sets have
  Japanese-script names UK staff can't type. TCGdex exposes the Pokémon's national dex
  number; a static EN species table (`lib/data/pokedex-en.json`, ~1,025 entries, generated
  once from TCGdex's EN card data by a small script) fills `alias_name` ("Charizard") at
  import. Search matches
  `name OR alias_name OR set_number`. Trainers/energy have no dex number and rely on
  set-number search — the JP-shop norm anyway.
- **Index on `(game, language)`** for filtered search and catalogue browse.
- `game` and `language` values come from dependency-free constants modules (`lib/games.ts`,
  extending the `lib/adjustment-reasons.ts` pattern — client components must not touch
  `lib/db`): id, label, `hasCatalogue` flag (false for manual games like Topps/Panini),
  supported languages.

**`external_id` convention (the dedupe keystone):** stays globally unique.

- Existing bare ids (`xy7-54`) are grandfathered as "pokemontcg.io, Pokémon, EN" and are
  **never rewritten** — the nightly sweep's `onConflictDoUpdate` targets them.
- New rows are source-qualified: `tcgdex:ja:sv4a-205`, later `scryfall:<uuid>`,
  `ygo:<passcode>`, `lorcast:<id>`.
- Cross-source duplicates are prevented **by construction**: the registry allows exactly
  one **catalogue-writing adapter** per (game, language). EN Pokémon stays pokemontcg.io;
  CJK Pokémon is TCGdex; no two sources ever create rows for the same printing. (An
  adapter may still use several upstreams internally — the EN Pokémon adapter keeps
  fetching Cardmarket prices from TCGdex exactly as today.)
- **Canonical codes:** DB `language` values are uppercase, matching the existing `'EN'`
  default — `'JA'`, `'KO'`, `'ZH-CN'`, `'ZH-TW'`. The lowercase codes inside qualified
  external ids (`tcgdex:ja:…`) are the source's own namespace, not ours.

**CSV inventory import:** the card-match key `(name, setNumber)` becomes
`(game, name, setNumber, language)`. The CSV gains optional `game` and `language` columns
defaulting to `pokemon`/`EN`, so every existing file imports unchanged. Card creation from
CSV rows stamps the resolved game/language.

**`price_cache`: no changes.** Scryfall's `usd`/`eur` are literally TCGplayer/Cardmarket;
YGOPRODeck exposes both marketplaces; TCGdex embeds both blocks. `pickMarketPrice`,
`pickMarketSource`, and the shop's Cardmarket-primary setting keep working untouched.

## 2. Source adapters & the import pipeline

New `lib/sources/` with a small interface (each adapter ≈ the size of the existing API
clients, 100–150 lines):

```ts
interface CatalogueSource {
  game: Game
  languages: Language[]
  // Paged/set-chunked full sweep — idempotent; first import and nightly refresh
  // are the same call (the sweepTcgplayerCatalogue contract today).
  sweep(onBatch: (cards: NormalizedCard[]) => Promise<void>, opts: SweepOpts): Promise<SweepResult>
  // Optional per-card price refresh — drives the nightly rotation and the
  // bounded on-demand refresh in search.
  refreshPrices?(externalId: string): Promise<NormalizedPrices | null>
  // Optional live-search fallback for cards newer than the last sweep.
  searchLive?(q: string): Promise<NormalizedCard[]>
}
```

`NormalizedCard` carries identity fields plus **native-currency** prices; GBP conversion
stays in the sync layer using settings rates (money remains integer pence, prices remain
server-canonical). A registry maps enabled (game, language) pairs to adapters.

Phase-1 registry:

| (game, language) | Adapter | Notes |
|---|---|---|
| pokemon / EN | `pokemontcg` | Existing client wrapped unchanged; TCGdex Cardmarket refresh as today |
| pokemon / ja, ko, zh-cn, zh-tw | `tcgdex` | New; catalogue + embedded Cardmarket **and TCGplayer** blocks |

**CJK import mechanics (cron-budget honest):**

- **Catalogue rows are cheap.** TCGdex lists sets per language; each set fetch returns card
  briefs (id, local number, name, image). The full JA catalogue is a few hundred requests —
  done by the one-off import script; the nightly sweep only picks up new sets.
- **Prices trickle through the generalized rotation.** TCGdex pricing needs a per-card
  fetch, exactly the shape of `syncStaleCardmarket`. That rotation dispatches to the card's
  source adapter (`refreshPrices`) instead of hardcoding `fetchCardmarketPrices` — dispatch
  keys on the row's `(game, language)`, which resolves grandfathered bare ids too. The
  TCGdex fetch also reads the embedded **TCGplayer** block — TCGplayer carries a Japanese
  Pokémon category, so JA cards often have USD data where Cardmarket is thin. In-stock
  cards keep nightly priority; the on-demand refresh in search covers CJK for free.
- **Rotation sizing:** ~20k EN + ~20k JA + smaller KO/ZH ≈ 45–50k rows → the full rotation
  stretches from ~fortnightly to ~monthly at 2,000/night. Acceptable (in-stock and
  searched cards jump the queue); the limit is a constant and can be raised — TCGdex
  answers well under a second.
- **Sweep orchestration** gains a per-run page budget with a persisted round-robin cursor
  across adapters, so phase-2's MTG (~100k printings) cannot starve Pokémon or overrun the
  Vercel cron window. Dormant while only one game is enabled. The platform `sync-tenants`
  fanout (15-min cursor-staggered) is unchanged; per-tenant work shrinks anyway because
  sweeps only touch enabled (game, language) pairs.

## 3. POS, buylist, and search behavior

**No-price workflow** (most KO/ZH Pokémon, all manual games, thin corners elsewhere):

- **Intake:** when the selected card has no cached market price, the add-stock form shows a
  prominent "No market data — set your selling price" callout surfacing the
  `sellPriceOverride` field. Not required — a box of JP bulk can still be shelved fast.
- **Till:** a priceless POS result swaps its disabled Add button for **Set price**: staff
  enters a price, it persists as the item's `sellPriceOverride` through the existing
  inventory PATCH (staff session attached), and the sale proceeds. Any staff member may
  quick-set; the price actually charged is already snapshotted on the sale line, which is
  what margin-VAT and reports consume. No new audit table.
- **Buylist:** no market anchor → manual offer entry with a "no market data — manual offer"
  banner; `buy_items.marketAtBuy` stays null (column already nullable), so overpayment
  audits correctly show these buys as unanchored.
- Server enforcement is unchanged: `createSale` still throws `NO_PRICE` without an override
  or market price.

**Search & UI:** one unified search box everywhere. Results gain a **language badge**
(JA/KO/ZH-CN/ZH-TW) so a JP printing is never mistaken for the differently-priced EN one;
once a second game is enabled, POS/buylist/catalogue get a game filter chip row.
`searchCards` accepts optional `{ game?, language? }` filters; default is all enabled.
Set-number search continues to work (JP local ids). Fuzzy matching stays trigram-based —
effective for `alias_name`, weak for CJK script, acceptable because CJK lookups run through
set numbers and aliases. The live-API fallback in search dispatches to the matching
adapter's `searchLive` where one exists.

## 4. Per-tenant enablement & plan gating

- Two new settings (tenant DB `settings`): **`enabledLanguages`** (default `['EN']`,
  ships in phase 1, applies to Pokémon) and **`enabledGames`** (default `['pokemon']`,
  ships in phase 2 — phase 1 hardcodes the one game). They gate:
  - **import** — sweeps and rotation only touch enabled pairs, keeping tenant DB row count
    and cron time proportional to what the shop stocks (Turso quota hygiene);
  - **search defaults and UI chrome** (badges, chips, catalogue filters).
  - Disabling later keeps existing rows and stock but stops syncing/surfacing them.
- **Entitlement:** `multiGame: boolean` in `lib/plan.ts` — Starter false, Growth/Pro true.
  Enforced server-side at the settings write (a Starter tenant cannot enable a second
  game). Languages ungated on all tiers. `TENANCY_MODE` unset (tests, e2e, Wizard-of-Oz
  single-tenant deploys) = full entitlements. Founding-shop exceptions via the existing
  registry `entitlement_overrides`.

## 5. Migration & backfill (live tenant DBs)

Deliberately boring, additive-only, deploy-order-safe (old code runs against the new
schema, so the standard migrate-then-deploy runbook flow applies):

1. Drizzle migration: `alias_name`, the `(game, language)` index, settings additions.
2. Backfill is a **verification, not a rewrite**: assert
   `count(*) WHERE game != 'pokemon' OR language != 'EN'` is 0 on existing DBs; existing
   `external_id`s untouched.
3. Data writes: `alias_name` populated as CJK rows import, plus a one-off species-alias
   script for any future retro-fill.
4. Applying migrations to live DBs remains a user-run step (migration/deploy gotcha
   runbook); the dev-boot drift guard catches lag.

## 6. Phasing

- **Phase 1 — JP/KO/ZH Pokémon (the shop's ask).** Activate `game`/`language` through
  import → search → POS; source-qualified external ids; TCGdex adapter; generalized price
  rotation; `alias_name` + species table; language badges; `enabledLanguages` setting;
  full no-price workflow; game-scoped CSV matching. No new games, no plan gating touched.
- **Phase 2 — multi-game machinery + easy games.** `enabledGames` + `multiGame`
  entitlement + game filter UI + sweep cursor; then MTG (Scryfall bulk data: free, no key,
  `usd`+`eur` embedded) and Yu-Gi-Oh! (YGOPRODeck full dump: one call, both marketplaces).
- **Phase 3 — long tail.** Lorcana (Lorcast, Scryfall-style, TCGplayer USD) and One Piece
  (TCGCSV nightly TCGplayer mirror); **manual games** for Topps/Panini — game entries with
  `hasCatalogue: false`, free-text card entry + CSV template, override-first pricing by
  definition, no market price ever shown.

Game order within phases 2–3 can swap on shop demand without spec changes. Phase-3 source
facts (Lorcast/TCGCSV field shapes) were verified only at survey level in the brainstorm —
re-verify endpoint/field details when writing that phase's implementation plan.

## 7. Testing

- Per-adapter unit tests: fixture JSON → normalized rows (pattern: `pokemon-tcg.test.ts`).
- Domain tests: game-scoped CSV matching; rotation dispatch to the right adapter;
  enablement gating (Starter blocked from a second game, import skips disabled pairs);
  till quick-set persists an override and unblocks `createSale`.
- Search tests: alias and set-number lookup for CJK rows; filter params.
- E2E: sell a JA card that has no market price via the till quick-set path.
- New/changed routes follow `guarded()` + `parseBody()` + `getTenantDb()`
  (tenancy-guard test enforces).

## Out of scope (on record)

- Condition-based pricing (own stub, 2026-07-22).
- Non-EN languages for non-Pokémon games.
- Online listings sync (own stub) — multi-game listing sync rides that spec.
- Linking translations to their EN counterpart beyond `alias_name` (no shared-identity
  table).
- Graded/slabbed sports-card workflows beyond plain singles rows for manual games.
