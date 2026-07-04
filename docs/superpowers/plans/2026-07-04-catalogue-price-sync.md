# Package C — Full catalogue + resilient price sync

**Spec:** `docs/superpowers/specs/2026-07-02-risk-fixes-design.md` (Package C), extended per owner decision 2026-07-04: pre-load the full card catalogue so day-to-day operation only refreshes prices — card search becomes local-first and the shop counter no longer depends on a live third-party API.

**Core insight:** the Pokémon TCG API embeds TCGplayer prices in every card object, and serves 250 cards/page (~80 pages for the ~20k English catalogue). So the one-time catalogue import and the nightly TCGplayer price refresh are **the same idempotent paged sweep**: upsert card rows by `externalId`, upsert `price_cache`, record `price_history`. New sets arrive automatically on the next sweep.

## Current problems this fixes

- TCGplayer prices are written once at card-insert and never refreshed (cron only does Cardmarket).
- `syncCardmarketForCard` UPDATEs `price_cache` — silent no-op when the row doesn't exist.
- Cron syncs serially, one failure aborts the rest, in-stock cards only.
- Card search waits on the live API on every keystroke-search and fails for unknown cards when the API is down.
- No price history anywhere.

## Design

**Schema (one migration):**
- `price_history`: `id, card_id FK, cardmarket_trend, tcgplayer_market` (pence), `recorded_on` text `YYYY-MM-DD`, unique `(card_id, recorded_on)`.
- Unique index on `cards.external_id` (required for upsert-by-externalId). Defensive pre-step in the migration: NULL out `external_id` on duplicate rows keeping the lowest id (SQLite allows multiple NULLs in a unique index).

**`lib/apis/pokemon-tcg.ts`:** add `fetchCardPage(page, pageSize=250)` → `{ cards, totalCount }`, `cache: 'no-store'`.

**`lib/prices/sync.ts`** (all functions take an optional `Db` for tests):
- `syncCardmarketForCard` — becomes an upsert (`onConflictDoUpdate` on `cardId`) + `price_history` insert-or-ignore for today.
- `sweepTcgplayerCatalogue(dbc, settings, { maxPages? })` — pages through the API; per card: upsert `cards` by `externalId` (insert new — this is how new sets and the initial import arrive), upsert `price_cache` TCGplayer fields + `lastSyncedAt` + `isHighValue`; insert `price_history` **only for cards that are in stock or high-value** (history for all 20k cards would be ~1.8M rows/90d for no reporting benefit). Per-page failure isolation: a failed page is recorded and skipped, the sweep continues. Returns `{ pagesFetched, pagesFailed, cardsSeen, newCards, pricesUpdated }`.
- `syncInStockCardmarket(dbc, settings)` — in-stock cards in concurrent batches of 8 via `Promise.allSettled` → `{ synced, failed }`.
- `pruneOldHistory(dbc)` — delete `price_history` older than 90 days.

**Cron `app/api/cron/sync-prices`** (still `CRON_SECRET`-guarded): runs sweep → cardmarket batch → prune; returns the combined summary. ~80 API requests + ~n_stock TCGdex requests, minutes not hours.

**`scripts/import-catalogue.ts`:** thin CLI wrapper around `sweepTcgplayerCatalogue` with page-progress logging — the one-time initial import (`npx tsx scripts/import-catalogue.ts`).

**Search `app/api/cards/search`:** DB-first with ranking — exact name match, then prefix, then substring, limit 50. The live-API + lazy-insert path only runs when the DB returns **zero** rows (safety net for a brand-new set between sweeps), preserving `insertCardSafely`.

## Not in this package

- No trend/history UI (capture only, per spec).
- No rarity or extra card columns — convert what's there.
- Cardmarket stays per-card via TCGdex (no bulk endpoint) and stays scoped to in-stock cards.

## Verification

- Unit tests for the sync module with an in-memory DB and stubbed `fetch`: upsert-not-noop, new-card insert on sweep, history subset rule, per-page failure isolation, prune cutoff.
- `npx tsc --noEmit`, `npm test`, `next build`, Playwright smoke test.
- Real import run (`import-catalogue.ts`) is an owner-triggered step, not part of CI.
