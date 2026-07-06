# Stub: catalogue browser (needs brainstorm)

Origin: owner smoke testing 2026-07-06 (`docs/testing/smoke-2026-07-06.md`, item 2).

## Problem

Search-only navigation assumes you know the card's name/spelling. The owner wants
"an easy way to see all of the cards on the market" — e.g. when buying from a
customer, browse the catalogue (by set, era, Pokémon) instead of typing a name.

## Known context

- Local catalogue is fully imported (~20k+ cards) in the `cards` table with
  `set_name`, `set_number`, `variant`, images, and `price_cache` rows.
- Buy page (`app/(app)/buylist/page.tsx`) and prices page (`app/(app)/prices/page.tsx`)
  are currently search-first.
- Related in-flight work: search overhaul (fuzzy matching, result caps, unified backend).

## Open questions for the brainstorm

- Where does browsing live — its own tab, or embedded in buy/prices flows?
- Browse hierarchy: set → card? Pokémon → printings? Both?
- How does it hand off into the buy cart / POS search?
- Pagination + image loading strategy for 20k cards.
- Owner's original note was cut off ("when buying, if you search a card it takes a…") —
  confirm the pain point with the owner before designing.
