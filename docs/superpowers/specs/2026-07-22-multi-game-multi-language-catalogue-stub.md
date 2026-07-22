# Stub: multi-game + multi-language catalogue (needs brainstorm → spec)

> **Superseded 2026-07-22** by `2026-07-22-multi-game-multi-language-catalogue-design.md`
> (brainstormed with Brad; all open questions below are resolved there). One correction to
> the "current state" section: `cards.game` and `cards.language` have existed since
> migration 0000 as dormant defaults — the pipeline ignores them, but the columns are real.

Source: first-shop demo 2026-07-22 (docs/testing/smoke-2026-07-22.md). Two asks that share one
root: the catalogue/pricing pipeline is Pokémon-English-only.

- **Languages:** shop needs Chinese / Japanese / Korean Pokémon cards (big singles market).
- **Games:** shop also sells Disney Lorcana, One Piece, Magic: The Gathering, Yu-Gi-Oh!,
  and Topps / Panini (sports/sticker collectibles).

## Current state (verified 2026-07-22)

- `cards` (lib/db/schema.ts) is Pokémon-shaped: name/setName/setNumber, no `game`, no `language`.
- Catalogue import: `scripts/import-catalogue.ts` + nightly cron sweep from Pokémon TCG API /
  TCGdex (lib/apis/). 20,359 cards on the staged demo DB.
- Prices: `price_cache` keyed by cardId; sources are Pokémon-only (Pokémon TCG API, TCGdex,
  Cardmarket trend via TCGdex). USD/EUR→GBP env rates.
- Products (non-card SKUs, PR #32) already handle sealed/accessories for ANY game — this stub
  is about **singles**.
- Memory/prior decision: "phase 2 multi-game singles needs its own spec" (products phase 1).

## Open questions for the brainstorm

- Schema: `game` + `language` columns on `cards` vs per-game tables; what happens to
  card-identity dedupe and `external_id`?
- Data sources per game (MTG: Scryfall; YGO: YGOPRODeck; Lorcana/One Piece: TBD; Topps/Panini:
  likely no API — manual/CSV?) and per-language Pokémon coverage (TCGdex languages; does the
  Cardmarket-trend rotation still work for JP/CN/KR printings?).
- Pricing honesty: many non-EN / non-Pokémon lines have thin or no market data — how does the
  POS present "no market price" stock (sellPriceOverride-first workflow?).
- Phasing: JP/CN/KR Pokémon first (same APIs, less new surface) vs a game-agnostic schema
  migration up front.
- SaaS angle: per-tenant game enablement (plan gating via lib/plan.ts?).

## Constraints

- Money integer pence; prices server-canonical (AGENTS.md domain rules).
- Migrations via drizzle-kit; live DBs lag code — backfill plan required for `cards`.
- Nightly cron sweep must stay idempotent and inside Vercel cron budget as the catalogue grows.

## Next step

Brainstorming session (superpowers:brainstorming) → full spec in docs/superpowers/specs/,
sized into phases. Do not start schema work without the spec.
