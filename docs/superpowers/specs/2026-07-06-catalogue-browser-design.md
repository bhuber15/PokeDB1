# PokeDB — Catalogue Browser
**Date:** 2026-07-06
**Status:** Approved (pending user review of this document)
**Scope:** A browse-by-set / browse-by-Pokémon-name UI over the fully-imported ~20k-card local catalogue, available as a standalone nav tab and embedded in the Buy (buylist) page, so intake doesn't depend on knowing a card's exact name/spelling.

---

## Origin and context

Owner smoke testing (`docs/testing/smoke-2026-07-06.md`, item 2) surfaced a truncated request: *"Is a catalogue of all the cards needed, EG as an easy way to see all of the cards on the market — when buying, if you search a card it takes a…"*. Follow-up with the owner confirmed the missing clause: **the search takes ages / freezes** — this is the same bug already tracked as smoke item 6 (zero-local-hits falls back to the live Pokémon TCG API with no timeout, freezing the input). The catalogue browser is a parallel, independent way to find a card that never depends on that live-API fallback path, since the full catalogue (~20,359 cards, 174 sets) is already imported locally with images and prices for every row.

This is a UI/navigation feature, not a data-import feature — the only data gap is a missing "era" grouping field (see below).

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Placement | Both: a standalone **Catalogue** nav tab, and the same browser embedded in the Buy page behind a Search\|Browse toggle |
| Browse hierarchy | Both entry points: **by Set** (grouped by era) and **by Pokémon** (distinct card name → all printings) |
| Era/series data | In scope — add `cards.series`, populate going forward via the nightly sweep, backfill existing rows with a one-time script |
| Cart handoff (Buy page) | Clicking a card in Browse mode goes straight into the existing add-to-cart panel — it does not re-run text search |
| Tab click action (standalone) | Clicking a card opens a read-only detail/price panel (reuses `CardZoomModal`) |
| "Browse by Pokémon" grouping | Exact `cards.name` string match, not species normalization (e.g. "Charizard" and "Charizard VMAX" are different browse entries) — avoids a fuzzy-NLP name-parsing problem that isn't needed for intake (a physical card's printed name is the exact string a customer holds) |
| Data scale strategy | Server-side queries per drill-down (Approach 1), not a client-side cache of the full catalogue — 174 sets / ≤304 cards per set is cheap to query live and keeps the feature isolated from the in-flight search-overhaul work |

---

## Data model

Add one nullable column: `cards.series` (text) — the Pokémon TCG API's `set.series` field (e.g. "Scarlet & Violet", "Sword & Shield", "Sun & Moon"), currently discarded by the import/sweep.

- **Schema**: add `series: text('series')` to the `cards` table in `lib/db/schema.ts`; run `npx drizzle-kit generate` for the migration.
- **Going-forward capture**: `lib/prices/sync.ts`'s `upsertPage` (used by both the nightly cron and `sweepTcgplayerCatalogue`) starts writing `series: c.set?.series ?? null` on insert and on conflict-update, alongside the existing `setName`/`setNumber`/`variant` fields.
- **Backfill**: new one-time script `scripts/backfill-series.ts` (run via `npx tsx`). Calls the Pokémon TCG API's `/v2/sets` endpoint once (174 sets, a single small response — not a per-card sweep), builds a `setName → series` map, and issues one `UPDATE cards SET series = ? WHERE set_name = ? AND series IS NULL` per distinct set name found locally. Any local `setName` with no match in the API's set list is logged and left `NULL` (falls into an "Other" era bucket in the UI — see Error handling).
- **No new `sets` table.** At 174 distinct sets, `SELECT DISTINCT set_name, series, count(*) FROM cards GROUP BY set_name, series` is cheap and keeps a second table from drifting out of sync with `cards`.

---

## API endpoints

Four new read-only routes under `app/api/cards/`, each wrapped in `guarded()` and calling `requireStaff(await getSession())` exactly like the existing `/api/cards/search` and `/api/cards/[id]` routes. None introduce new auth surface, and none touch the fuzzy-matching logic in `/api/cards/search` (kept separate from the in-flight search-overhaul work).

1. **`GET /api/cards/sets`** — no params. Returns every distinct `(setName, series, count)` group. Era headers are ordered using a static `SERIES_ORDER` list (chronological release order, e.g. `['Base', 'Neo', ..., 'Sword & Shield', 'Scarlet & Violet']`) defined alongside the route, since `cards` has no release-date column to sort by; a `series` value not found in the list (including `null`/"Other") sorts last. Within an era, sets are ordered alphabetically by `setName`. 174 rows total; returned in one response, no pagination.
2. **`GET /api/cards/browse?setName=X`** — all cards where `set_name = X`, left-joined to `price_cache`, ordered by `set_number` (natural in-set order). Largest set is 304 cards (SWSH Black Star Promos) — returned in one page.
3. **`GET /api/cards/names?q=`** — distinct `cards.name` values, optionally prefix/substring-filtered by `q`, capped at 50, alphabetical. Powers the "browse by Pokémon" entry list's type-ahead.
4. **`GET /api/cards/browse-by-name?name=X`** — all rows where `name = X` exactly (every printing/set that card name appears in), left-joined to `price_cache`, ordered by `series` then `set_number`. This is what a name click drills into.

Response shapes mirror the existing `{ cards: Card[] }` / `{ ...card, priceCache }` conventions already used by `/api/cards/search` and `/api/cards/[id]`.

---

## UI components

### `components/catalogue/CatalogueBrowser.tsx` (new, client component)

The shared piece used by both hosts below.

- **Mode toggle** at the top: **By Set** / **By Pokémon**.
- **By Set**: left rail lists sets grouped under collapsible era headers (from `series`, ordered by the API's `SERIES_ORDER`; ungrouped/null rows under a trailing "Other" header), with a text filter box to narrow 174 sets quickly. Selecting a set loads its full card grid via `/api/cards/browse`.
- **By Pokémon**: a searchable list of distinct names (`/api/cards/names`), re-queried as the user types past the initial capped result. Selecting a name loads every printing via `/api/cards/browse-by-name`.
- **Card grid tile**: `next/image` (lazy-loaded), name, set name + number, a market-price chip from the joined `price_cache` row.
- Clicking a tile calls a required `onSelectCard(card, priceCache)` prop — the host component decides what happens next. `CatalogueBrowser` itself has no knowledge of "buy" or "price detail" semantics.
- No infinite scroll or virtualization: the largest possible result set from any of the four endpoints is 304 rows — a plain grid renders that fine.

### `app/(app)/catalogue/page.tsx` (new)

Renders `CatalogueBrowser` with `onSelectCard` wired to open the existing [`CardZoomModal`](../../../components/shared/CardZoomModal.tsx) (already supports price fields) in its read-only mode — no changes needed to that component.

### Buy page ([buylist/page.tsx](../../../app/(app)/buylist/page.tsx))

Add a Search\|Browse toggle next to the existing search box. Browse mode renders `CatalogueBrowser` with `onSelectCard` wired to the same add-to-cart panel `BuyCard` already presents for search results — browsing becomes a second path into the identical add flow, not a duplicate one.

### Nav ([Nav.tsx](../../../components/layout/Nav.tsx))

Add a "Catalogue" entry between Buy and Customers, following the existing link-array pattern (icon + href + label).

---

## Error handling and edge cases

- **Empty result**: `browse` / `browse-by-name` return `{ cards: [] }` for a query that matches nothing (shouldn't happen given the data's invariants, but handled) — UI shows a plain "No cards found" state, same pattern as the existing search's empty state.
- **Missing `series`** (rows the backfill couldn't match, or a future set the API adds before the next sweep runs): grouped under an "Other" era bucket in the Set browse view rather than hidden.
- **Backfill script resilience**: unmatched set names are logged to stdout and skipped, not thrown — mirrors `sweepTcgplayerCatalogue`'s existing per-page failure isolation. The script is safe to re-run (only updates rows where `series IS NULL`).
- **Auth**: all four new routes require an authenticated staff session, consistent with every other `/api/cards/*` route. No public/unauthenticated access.
- **Client-bundle boundary**: `CatalogueBrowser` and both host pages are `'use client'` and only communicate via `fetch('/api/...')` — never a value-import from `lib/domain/*` or anything touching `lib/db`, per the repo's client-bundle boundary rule.

---

## Testing

- **New route tests** (colocated `route.test.ts` per endpoint, matching the existing pattern for `/api/cards/search`): sets grouping/ordering including an "Other" bucket for null series; browse-by-set returns every row for a seeded set; browse-by-name matches the exact name only (not a substring); names endpoint respects the 50-cap and prefix filter; unauthenticated requests are rejected for all four routes.
- **Backfill script test**: unit test against a small fixture set list — confirms matched sets update `series` correctly, and an unmatched set name is logged and left `NULL` without throwing.
- **No `lib/domain/` changes** — this feature is read-only browsing and doesn't touch sales/buys/refunds logic, so no domain-layer test updates are needed.
- **Manual verification**: exercise both Set and Pokémon browse modes on `/catalogue` and embedded in Buy, against the seeded dev data. The 57-row Snorlax case (Flashfire #80 / Generations #58, confirmed as distinct legitimate reprints in the smoke-test triage) is a good manual case for "same name, multiple printings" in the By-Pokémon mode.

---

## Out of scope (for this spec)

- Fixing the live-API search freeze/timeout itself — tracked separately under the **search overhaul** work item (smoke items 1, 6, 7).
- Species-level grouping (e.g. unifying "Charizard" and "Charizard VMAX" as one browse entry) — exact-name matching only, per the brainstorm decision above.
- Any change to `/api/cards/search`'s fuzzy-matching or ranking logic.
- Tab renaming (smoke item 5) — separate, blocked on the owner supplying a full old→new label mapping.
