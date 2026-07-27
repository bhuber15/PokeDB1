---
name: add-card-game
description: Use when adding a new trading card game (Lorcana, One Piece, Digimon, sports cards…) to the catalogue, wiring a new external card-data source, or scoping what such an addition involves.
---

# Add a Card Game

The machinery is registry-driven: game N+1 is ~9 files of lib/scripts/tests work — usually **no DB migration and no UI edits**. Mirror the newest shipped game end to end. If this page drifts from the code, `grep -rln '<newest-game-id>' lib scripts tests` regenerates the authoritative seam list — trust the grep over the table below.

Scope check: a catalogue-backed, EN-only game on the existing machinery is a focused feature (short design note + TDD), not a full plan cycle. Manual games (`hasCatalogue: false`), new languages, or schema changes break that assumption — brainstorm those first.

## Iron rule: verify the source live before any code

Coding from docs/memory caused four real data bugs last time: non-EN rows inside "English" bulk data, empty rarity codes producing unparseable ids, duplicate printings, unstable page order. Curl the actual endpoints first. Record in the design note: auth, rate limits + required headers (Scryfall 403s without a User-Agent), bulk vs paged + sizes, refresh cadence, and every price field with its currency. Build test fixtures from real responses.

## Decisions to record (short note in docs/superpowers/specs/)

| Decision | Rule / precedent |
|---|---|
| Row grain | "A differently-priced printing is its own card." MTG: one row per finish; YGO: one per (passcode, set, rarity). If foil ≠ nonfoil price, they are two rows. |
| external_id | `<source>:<id>[:qualifier]`, segments alnum-only (see `raritySlug`), must round-trip `parseExternalId`. Existing ids are never rewritten. |
| Price mapping | Native currency → integer pence in the sync layer (`PRICE_USD_TO_GBP` / `PRICE_EUR_TO_GBP`). USD-marketplace fields → `tcgplayer_*`, EUR → `cardmarket_*`. Never fabricate a figure the source doesn't honestly carry (YGO leaves Cardmarket null; `pickMarketSource` falls back). null/`0` → the no-price workflow. |
| Sweep shape | Small catalogue → full nightly re-upsert (YGO). Huge → paged sweep with page budget + cursor persisted in `catalogue_sync_state` (MTG). The initial load is always the off-cron import script, never the cron. |
| Languages | New games ship `['EN']`. |

## Wiring checklist — every row REQUIRED

Rows 2–6 have colocated `*.test.ts` that must grow with them.

| # | File | Change |
|---|---|---|
| 1 | `lib/games.ts` | `GAME_IDS` entry + `GAMES` meta. Module stays dependency-free (client-bundle rule). |
| 2 | `lib/sources/external-id.ts` | id builder, `ParsedExternalId` variant, `parseExternalId` branch |
| 3 | `lib/apis/<source>.ts` | fetch + normalize → `NormalizedCard[]` |
| 4 | `lib/sources/<source>-sweep.ts` | idempotent sweep through the shared upsert |
| 5 | `lib/sources/registry.ts` | `CATALOGUE_SOURCES` entry; `refreshPrices` if the API has a cheap per-card fetch |
| 6 | `lib/prices/sync.ts` | extend the source→game dispatch in `syncMarketPricesForCard` — it is hardcoded per source; miss it and the game's cards silently fall through to the Pokémon path |
| 7 | `scripts/import-catalogue.ts` | bulk pass, double-gated on `--only` AND `settings.enabledGames` |
| 8 | `tests/e2e/seed.ts` + `tests/e2e/multi-game-checkout.spec.ts` | seed + sell one card of the new game through the till |

Registry-driven — do NOT edit: `GameFilter`, game badges, Settings→Games toggle, `settingsPatchSchema` (`z.enum(GAME_IDS)`), `multiGame` entitlement, tenancy plumbing, `lib/sources/upsert.ts`.

## Rollout

1. A standard game needs no migration (`cards.game` is text). If schema DID change: deploys never auto-migrate — the migrate-tenants contract applies.
2. Per shop: enable in Settings → Games first (Growth+ on multi-tenant), then `npx tsx scripts/import-catalogue.ts --only=<game>` — the import silently skips disabled games.
3. The nightly cron picks the new game up from `enabledGames` automatically.

## Verify

- Adapter tests: row grain, per-variant prices, null/`0` → no-price, and dedupe rows by external id before insert (duplicate printings hit SQLite "could not affect row a second time").
- Regression: existing sources' normalized output unchanged.
- `npm test`, `npm run lint`; live: import `--only` into local-sandbox.db, search it, sell one at the till. e2e in a fresh worktree: the first run is a throwaway cache-warmer.

## Common mistakes (all real)

- Skipping the live source check and coding from docs or memory.
- Forgetting checklist #6 — everything works except prices never refresh, silently.
- Unthrottled paged crawls: serialise (~100 ms gate) and send a User-Agent.
- Wiring the new game into the Pokémon Cardmarket rotation — it is scoped to Pokémon on purpose.
- Ordering a paged crawl by a mutable field — the cursor must be stable (e.g. `released:asc`).

## References

- `docs/superpowers/specs/2026-07-23-multi-game-mtg-ygo-design.md` — decisions + verified source facts (the model to copy)
- `docs/superpowers/specs/2026-07-22-multi-game-multi-language-catalogue-design.md` — umbrella identity rules
- Template chain: `lib/apis/ygoprodeck.ts` → `lib/sources/ygoprodeck-sweep.ts` → its registry entry (or the scryfall chain for paged sources)
