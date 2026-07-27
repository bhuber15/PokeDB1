# Disney Lorcana singles — design

Status: implemented 2026-07-27. First validation run of the `.claude/skills/add-card-game`
skill; phase-3 game named by the umbrella spec (`2026-07-22-multi-game-multi-language-
catalogue-design.md` §Phase 3: "Lorcana (Lorcast, Scryfall-style, TCGplayer USD)").
Pure-code addition on the PR #38 machinery: no migration, no UI edits.

## Source facts — verified live against api.lorcast.com, 2026-07-27

- **Endpoints:** `GET /v0/sets` → `{results: Set[]}`; `GET /v0/sets/:code/cards` →
  **bare array** (different envelope!); `GET /v0/cards/:crd_id` → card; also
  `/v0/cards/:set/:number` and `/v0/cards/search?q=`. No auth, no key.
- **Scale:** 20 sets (main 1–13 "Attack of the Vine!" 2026-07-17, plus P1/P2/P3, D23,
  cp, C2, DIS). Main sets ~230–245 cards → roughly 4.5k printings, ~8k rows per-finish.
  Whole game ≈ 21 requests — YGO-class, full nightly re-upsert, no cursor.
- **Rate limit:** documented 50–100 ms between requests; 429 then IP bans for abuse.
  Card images live on `*.lorcast.io` (AVIF), explicitly un-rate-limited, cache ≥24 h.
- **Card object:** `id` (`crd_<hex>`, stable), `name` + nullable `version`
  ("Elsa" / "Spirit of Winter"), `rarity`, `collector_number` (string), `lang`,
  `set {id, code, name}`, `image_uris.digital.{small,normal,large}`,
  `prices {usd?, usd_foil?}`, `tcgplayer_id`.
- **Quirks the fixtures must cover (all observed live):**
  - `prices` values are **numbers on /cards endpoints but strings on /sets/:code/cards**
    (`9.79` vs `"262.76"`) — coerce both.
  - Rarity vocabulary is **open**: Common, Uncommon, Rare, Super_rare, Legendary,
    Enchanted, plus Epic + Iconic (set 9 on) and Promo (promo sets). Treat as opaque
    except for the foil-only tier.
  - **Price-key presence tracks physical finishes**: set 13 = 201 both / 38 foil-only
    (its Enchanted/Epic/Iconic exactly) / 6 nonfoil-only; P1 promos 35/41 foil-only.
    A few promos carry no `prices` at all.
- Licence: community API under Ravensburger's Community Code Policy (same posture as
  YGOPRODeck); attribution noted here, nothing product-facing required.

## Decisions (per the add-card-game skill table)

1. **Row grain — per finish, like MTG.** Finish existence comes from **price-key
   presence** (`usd` → base row, `usd_foil` → Foil row). When `prices` is empty:
   Enchanted/Epic/Iconic → Foil row only (always cold-foil physically); anything else →
   both rows (a phantom variant row is harmless; a missing row blocks a sale).
   `variant` = `''` | `'Foil'`. Rarity is not stored (MTG precedent — collector number
   already distinguishes Enchanted reprints).
2. **external_id:** `lorcast:<crd_id>` / `lorcast:<crd_id>:foil`. The `crd_` id
   round-trips to `GET /v0/cards/:id` for the per-card refresh.
3. **Price mapping:** `usd`/`usd_foil` (string|number) → `tcgplayerUsd` →
   `tcgplayer_market` in pence at `PRICE_USD_TO_GBP`. **Cardmarket stays null** — Lorcast
   has no EUR figure and we don't fabricate one (YGO precedent); `pickMarketSource`
   falls back. Missing/`0` → no-price workflow.
4. **Sweep:** sets list → per-set cards, serialised with a 100 ms gate, full re-upsert
   nightly through the shared `upsertNormalizedCards`. Per-set failures increment
   `failed` and continue (one bad set must not kill the sweep). Initial load = the same
   sweep via the `import-catalogue.ts` pass (no separate bulk path needed at this size).
5. **Languages:** `['EN']`; the sweep drops `lang !== 'en'` rows defensively (the
   Scryfall non-EN-rows-in-EN-bulk lesson).

Display name joins name + version: `"Elsa - Spirit of Winter"`; version-less cards
(actions/songs/items) keep the bare name.

## Out of scope

- Non-EN Lorcana; a Cardmarket EUR source for Lorcana (none honest today).
- One Piece (TCGCSV) — next long-tail game, own note.
- Back-catalogue price history for Lorcana (starts accruing from first sync).
