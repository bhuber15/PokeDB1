# Products (non-card SKUs) — phase 1 design

Date: 2026-07-19
Context: card shops don't only stock Pokémon cards. Phase 1 makes the till able to sell
**non-card products** (sealed, accessories, snacks, slabs, anything). Phase 2 — multi-game
*singles* catalogues (MTG, Yu-Gi-Oh, …) — is a separate spec, deliberately not designed here.

## Goal

A shop can create a product (name, category, barcode, price, stock), find it at the POS by
name or barcode scan, and sell it in the same basket as singles — with correct VAT, refunds,
voids, receipts, and reports. Smallest possible diff: products reuse the existing stock
ledger and the entire money pipeline downstream of it.

## Current state

- Every `inventory_items` row requires a card: the schema's `cardId` is nullable but the
  API contract (`app/api/inventory/route.ts` zod) and all creation paths require it. A
  booster box or a pack of sleeves cannot be rung up at all.
- The money pipeline (sales, split tender, refunds, voids, stock adjustments, cash-ups,
  low-stock, reports) keys on `inventory_item_id` — none of it is card-specific.
- `createSale` prices each line as `sellPriceOverride ?? market price × margin`
  (`lib/domain/sales.ts`); the priceCache join is via `inventoryItems.cardId` (left join,
  so a null `cardId` degrades safely to the override).
- VAT scheme (`none | standard | margin`) is a shop-level setting applied per sale (F2).

## Scope decisions (agreed with owner, ponytail-reviewed)

- Products first; multi-game singles later (separate spec).
- Full retail SKU: name, category, EAN, cost, price, stock, low-stock. Manually priced.
- Buylist stays **singles-only**. POS flow is **search + barcode scan** — no quick-pick grid.
- Cut as YAGNI (each is a one-line migration later if ever needed): `products.game`,
  `products.imageUrl`, `products.isActive` (the product's stock row's `isActive` is the
  single deactivation flag).

## Design

### 1. Schema — migration 0020

```ts
export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category').notNull(), // see lib/product-categories.ts
  ean: text('ean').unique(),            // nullable; SQLite treats NULLs as distinct
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})
```

- `inventory_items` gains nullable `productId` referencing `products.id`, plus a partial
  unique index (`WHERE product_id IS NOT NULL`) so a product has exactly one stock row —
  the split-quantity bug `scripts/dedupe-inventory.ts` exists to clean up can't happen here.
- Product stock rows use `condition = 'NA'` (avoids a SQLite table rebuild to relax
  `NOT NULL`; card-condition queries never match `'NA'`).
- **No DB CHECK for "exactly one of cardId/productId"**: adding a CHECK to an existing
  SQLite table forces a rebuild of the busiest table. The invariant is enforced at the two
  creation choke points instead (existing inventory route stays card-required; the new
  products endpoint is the only writer of `productId`). Upgrade path: fold a CHECK into a
  future rebuild migration if one ever happens anyway.
- `lib/product-categories.ts`: dependency-free constants
  (`sealed | accessories | snacks | other` + display labels), same pattern as
  `lib/adjustment-reasons.ts`, so client components can value-import it (client-bundle rule).

### 2. API

- **`POST /api/products`** — `guarded()` + `parseBody()`. Body: `name` (min 1),
  `category` (enum), `ean?` (8–14 digits), `sellPrice` (int pence > 0, required),
  `costPrice?` (admin-gated per F8 conventions), `quantity` (int ≥ 0),
  `lowStockThreshold?`. One transaction in `lib/domain/products.ts` → insert `products`
  row + its single `inventory_items` row (`condition 'NA'`, `sellPriceOverride = sellPrice`,
  fresh QR code as usual).
  - EAN collision: if the EAN belongs to a product whose stock row is **inactive**, reuse
    that product row (update name/category/price, reactivate stock) — re-stocking a
    discontinued line just works. If **active**, throw `DomainError('duplicate_ean')`.
- **`PATCH /api/products/[id]`** — rename / re-categorise / fix EAN. Price, cost, quantity
  and deactivation all go through the **existing** inventory edit + stock-adjustment
  endpoints, which work on the stock row unmodified.
- **`GET /api/inventory`** — left join `products`; product rows return name/category/ean
  where card fields are null. No separate products list endpoint.

### 3. POS search + basket

- The POS search path gains products: queries matching `/^\d{8,14}$/` try an exact EAN
  lookup **first** (a USB scanner types digits + Enter — scan-to-basket with zero new UI);
  all queries also LIKE-match product names alongside card results. Products return with
  their stock row so "add to basket" uses `inventoryItemId` exactly like cards. No fuzzy
  matching for products (substring is enough for a shop's own SKU names).
- Basket, checkout, split tender, store credit, offline replay: **unchanged** (all keyed
  on inventory item ids).

### 4. VAT — one branch, not a system

Per-line in `createSale` (which already walks lines for the margin computation):

| Shop scheme | Card line (today, unchanged) | Product line (new) |
|---|---|---|
| `none` | no VAT | no VAT |
| `standard` | standard (VAT-inclusive × 1/6) | same as cards |
| `margin` | margin VAT on (price − cost) | **standard (× 1/6)** — new retail goods are never margin-scheme eligible |

`marginNoCostHandling` does not apply to product lines. Refunds reuse the existing F2
reversal mechanics with the same per-line treatment — no new machinery; parity verified
by test.

### 5. Receipts, history, reports

- Receipt/email/sales-history line naming: add a `products` left join beside the existing
  `cards` join; display product name when `productId` is set.
- Reports: each sold line classifies as `product.category`, or `'singles'` for card lines.
  Existing aggregates gain that one dimension; margin visibility stays admin-gated (F8).
- Voids, cash-ups, credit ledger: untouched.

### 6. UI

- Inventory page: an "Add product" form (name, category, EAN, price, cost [admin-only],
  quantity, low-stock threshold) beside the existing card flow; product rows show a
  category chip + EAN. Deactivate/adjust reuse existing controls.
- POS: product results render with name, category and price; add-to-basket as any line.

## Invariants

- A product's stock row always has `sellPriceOverride` set (enforced at creation; the
  existing "line has no resolvable price" guard in `createSale` is the backstop — verify
  it throws rather than NaNs during implementation).
- `productId` and `cardId` are mutually exclusive on `inventory_items` (choke-point
  enforcement, § 1).
- All money integer pence; prices server-canonical — unchanged.

## Non-goals (deferred, with upgrade paths)

- **Multi-game singles** — phase 2, own spec. Seams already present: `cards.game`,
  source-agnostic `price_cache`; add per-game import/price adapters + a per-shop
  "games you sell" setting when we get there.
- Buylist for products (add `buyItems.productId` if shops ask).
- Quick-pick grid (revisit if the beta shop asks).
- Market prices for sealed (TCGCSV adapter later; prices stay manual).
- Product images, `game` tag on products, CSV product import, want-list products.

## Testing / done-gate

- `lib/domain/products.test.ts`: create (happy, duplicate-EAN active, inactive-EAN reuse),
  mutual-exclusivity, price-required.
- `sales.test.ts` additions: mixed basket under each VAT scheme (product line
  standard-rated under `margin`), refund of a product line reverses VAT + restocks.
- Search tests: EAN exact hit, name match merging, digits-that-match-nothing falls through
  to card search.
- e2e: extend the **existing** checkout smoke with one seeded product added via typed EAN —
  not a new spec file.
- Gate: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm run test:e2e`.

## Rollout

- Migration 0020 to the live dev DB is a user-run step (deploys don't auto-migrate; unset
  shell `TURSO_*` first — standing gotcha). Single-tenant and multi-tenant identical
  (tenant DBs share the schema journal).
- Verify `/api/settings/full-export` picks up the `products` table (plan task).
