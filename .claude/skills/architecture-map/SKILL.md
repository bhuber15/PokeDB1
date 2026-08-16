---
name: architecture-map
description: Use when the architecture map needs work — a mapped back-end flow changed, scripts/architecture-map.test.ts failed, a new area or part is being added to it, or someone needs a server-side flow explained end to end.
---

# Architecture Map

An explorable map of PokeDB's back end, published at
<https://claude.ai/code/artifact/331b9d1f-4753-40f1-9da8-2ab3b90b1af4>.

Six areas, switchable in one page: **selling a card**, **money back out**, **buying
cards in**, **the card catalogue**, **running many shops**, **when the wifi dies**.
47 parts, plus 20 more inside drill-downs.

## Who it is for

The owner reads this to understand their own codebase and to explain it to other
people. That sets the writing standard, and it is the part most likely to be got wrong:

| Field | Audience | Test |
|---|---|---|
| `what` | a shop owner, an investor, a friend | Could they repeat it out loud after one read? No file names, no jargon. |
| `how` | a developer | Does it name the real file and mechanism, so they can go and look? |
| `condition` | both | Is it honestly what is unfinished or odd, rather than reassurance? |

## Two layers, and why the split is the whole design

| Layer | Lives in | Who writes it | How it stays true |
|---|---|---|---|
| **Derived** — route/module/table/migration/test counts | `scripts/architecture-facts.ts` | nobody, it is counted | recounted at every build |
| **Authored** — areas, parts, links, positions, prose | `docs/architecture/map.json` | you | `scripts/architecture-map.test.ts` |

A number a human types is a number that rots. Deriving the counts already corrected two
hand-written ones. `docs/architecture/explorer.html` is **generated** — rebuild it, never
hand-edit it.

## Files

| File | Role |
|---|---|
| `docs/architecture/map.json` | source of truth for everything authored |
| `docs/architecture/template.html` | the renderer — canvas, panes, view switching |
| `docs/architecture/explorer.html` | generated output, published as the artifact |
| `scripts/build-architecture-page.ts` | inlines map + derived facts into the template |
| `scripts/architecture-facts.ts` | counts routes, modules, tables, migrations, tests |
| `scripts/architecture-map.test.ts` | the drift guard, runs inside `npm test` |

## Iron rule: prose carries the why, never the what

The code already says what it does, and says it more reliably than this map ever will. A
part earns its place by holding **the reason a reader could not derive from the file in
front of them** — the race it was written to survive, the rounding it was written to
absorb, the product decision that looks like a bug.

Mine the code comments first; they are unusually good, and most of the best lines in the
map came straight out of them.

- `lib/domain/sale-claim.ts` — the whole file exists because of one race.
- `lib/domain/refunds.ts` — the residual cap, and what rounding does over ten refunds.
- `lib/trading-day.ts` — why void eligibility and reports use different days on purpose.
- `lib/domain/buys.ts` — why the buy cap is integer arithmetic against a *conditioned* price.
- `lib/platform/fanout.ts` — why a failing shop must still advance the cursor.

A part whose prose could be replaced by reading the file is a part to delete.

## Updating the map after a change

1. **Run the guard.** `npm test`, or tighter: `npx tsx --test scripts/architecture-map.test.ts`.
   The failure message names what drifted. Done when you can state which parts the change
   touches, or that it touches none — a change outside the mapped areas needs no map edit.
2. **Read the changed code before writing about it.** Done when you can name the reason
   the change was made, not only its shape.
3. **Edit `map.json`.** Schema below. Done when every touched part reads true in both
   registers, and no part names a file that moved.
4. **Rebuild.** `npx tsx scripts/build-architecture-page.ts`
5. **Re-run the guard.** Done when all eight checks pass.
6. **Republish to the same URL** — pass `url` (the link above) to the Artifact tool with
   `file_path` `docs/architecture/explorer.html`. Publishing without `url` creates a
   second artifact and strands the first.

## Schema

```jsonc
// views[] — one per area, each with its own index and walkthrough
{ "id": "sale", "label": "Selling a card", "blurb": "from the shelf to the ledger",
  "run": "Run the sale",              // the play button's label in this area
  "intro": "one paragraph, plain English",
  "groups": [{ "label": "the shop counter", "nodes": ["till", "queue"] }],
  "flow":   [{ "node": "till", "note": "one plain-English beat" }] }

// nodes[] — one definition, positioned in every area it appears in
{ "id": "createSale",
  "label": "createSale",              // drawn on the card — keep short
  "kind": "logic",                    // logic | route | gate | table | pure | screen
  "layers": 6,                        // TICKS IN THE CORNER = how many jobs it does
  "file": "lib/domain/sales.ts",      // real path — the test asserts it exists
  "sub": "the only place a sale is made",
  "accent": true,                     // see below — spend sparingly
  "pos": { "sale": [2, 0], "offline": [3, 0] },   // [column, row] per area
  "what": [], "how": [], "condition": [],
  "children": [ /* col/row instead of pos — the GO INSIDE map */ ] }

// edges[] — an edge draws in every area where BOTH ends are placed
{ "from": "tx", "to": "ledger", "kind": "write", "label": "credit spent" }
```

`kind` is load-bearing, not decoration: `screen` draws a broken outline because it runs in
the browser and is not trusted; `table` gets a plate line; `pure` means it touches no
database. `kind` of an edge: `flow` (the main path), `read`, `write` (money or stock
moves, drawn red), `guard`.

**`accent` means one thing: this part exists to survive a race or a rounding penny.** It is
the page's thesis in red. Adding one requires it to be true.

Edge labels must stay **under ~16 characters** — they sit in the gap between two cards and
spill onto them if longer. Prose markup: `==text==` highlights, `` `code` `` inlines.

## Adding an area or a part

Add a `views` entry, position the parts in it via each node's `pos`, and add edges. The
layout has no collision detection: place, rebuild, and look at it. Keep an area under
about 13 parts — beyond that it stops fitting a screen and stops being an overview.

Give the parts where money or concurrency bites a `children` drill-down; leave the rest at
one level. Depth everywhere is how a map becomes unreadable.

Update `coverage` when an area lands, so the page keeps telling the truth about what it
does not cover.
