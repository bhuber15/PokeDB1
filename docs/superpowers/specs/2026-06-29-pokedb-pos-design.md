# PokeDB — Collectible Card Shop POS & Database System
**Date:** 2026-06-29  
**Status:** Approved  
**Scope:** Full system — POS, inventory, buylist, graded cards, pricing, reporting, staff management  
**Location:** UK  

---

## 1. Overview

A hybrid web-based POS and inventory management system for a collectible card shop. Primary focus is Pokemon cards, with support for any card game/brand. Staff use it at the counter to sell cards, buy cards from customers, manage inventory, and view reports. The system works offline mid-sale and syncs when connectivity restores.

---

## 2. Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | Next.js 15 (App Router) | PWA support, API routes, single repo |
| UI | Tailwind v4 + shadcn/ui | Clean, accessible, non-technical staff friendly |
| Database | Turso (LibSQL / SQLite) | Simple, cloud-synced, zero ops |
| ORM | Drizzle ORM | TypeScript-native, first-class Turso support, migration system |
| Offline | IndexedDB + Service Worker | Browser-side cache of inventory + prices; writes queued offline |
| File storage | Vercel Blob | Condition photos for high-value cards and graded slabs |
| Hosting | Vercel (Fluid Compute) | Auto-deploy, preview URLs, cron jobs |
| Auth | Next.js Middleware + bcrypt | Owner password protects web app; staff PINs protect POS session |

---

## 3. Authentication

Two separate layers:

**App-level (owner):**
- Single owner password stored as bcrypt hash
- Next.js middleware protects all routes
- Session via signed cookie (NextAuth or iron-session)
- Recommended: enable 2FA via TOTP for owner login

**POS session (staff):**
- 4-digit PIN per staff member (hashed in DB)
- PIN login at the start of each POS session
- Auto-locks after 10 minutes of inactivity
- Every sale, buylist entry, stock edit, and discount records the staff ID

---

## 4. Data Model

### 4.1 `staff`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| name | text | |
| pin_hash | text | bcrypt hashed 4-digit PIN |
| role | text | `admin` or `staff` |
| is_active | boolean | soft disable without deleting |

### 4.2 `cards`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| name | text | |
| game | text | `pokemon`, `mtg`, `ygo`, or any string |
| set_name | text | |
| set_number | text | e.g. `199/165` |
| variant | text | `holo`, `reverse_holo`, `1st_edition`, `shadowless`, etc. |
| language | text | default `EN` |
| tcgplayer_id | text nullable | for pricing API lookup |
| image_url | text | from Pokemon TCG API / Scryfall / YGOProDeck; manually uploaded to Vercel Blob for other games |
| image_url_large | text nullable | large variant where available (Scryfall, Pokemon TCG API) |

### 4.3 `products`
Non-card inventory: sealed product and accessories.

| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| name | text | |
| category | text | `sealed` or `accessory` |
| game | text nullable | e.g. `pokemon` for a Pokemon ETB |
| barcode | text nullable | standard UPC/EAN from packaging |
| image_url | text nullable | |

### 4.4 `inventory_items`
Single source of truth for stock of raw cards and products.

| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK nullable | → cards |
| product_id | integer FK nullable | → products |
| condition | text | `NM`, `LP`, `MP`, `HP`, `DMG` |
| quantity | integer | |
| cost_price | decimal | what the shop paid |
| sell_price_override | decimal nullable | if null, auto-calculated from market price × margin |
| qr_code | text | UUID v4 generated server-side on item creation, encoded as QR on printed labels |
| condition_photo_url | text nullable | Vercel Blob URL |
| location | text nullable | physical location e.g. `Case 3 / Slot B7` |
| defect_notes | text nullable | e.g. `Small scratch on holo surface` |
| low_stock_threshold | integer | default 1; alert when quantity ≤ this |
| created_at | timestamp | |

Constraint: exactly one of `card_id` or `product_id` must be set.

### 4.5 `graded_cards`
Each row is a unique, serialised slab. Quantity is always 1.

| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK | → cards (base card identity) |
| grading_company | text | `PSA`, `BGS`, `CGC` |
| grade | decimal | e.g. `10`, `9.5`, `8` |
| cert_number | text UNIQUE | unique per slab |
| population | integer nullable | pop report at time of purchase |
| cost_price | decimal | |
| sell_price | decimal | manually set or from Card Ladder |
| condition_photo_url | text nullable | required for purchases above threshold |
| location | text nullable | physical location |
| defect_notes | text nullable | |
| sold_at | timestamp nullable | null = in stock |
| staff_id | integer FK | staff who added the item |
| created_at | timestamp | |

Graded cards are never deleted — marked as sold with `sold_at` timestamp.

### 4.6 `price_cache`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK | → cards |
| tcgplayer_market | decimal nullable | |
| tcgplayer_low | decimal nullable | |
| pricecharting_loose | decimal nullable | loose/ungraded price from PriceCharting |
| pricecharting_graded | decimal nullable | graded price from PriceCharting |
| ebay_avg_sold | decimal nullable | populated when eBay API approved |
| last_synced_at | timestamp | |
| is_high_value | boolean | true if market price > configured threshold |

### 4.7 `price_history`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK | → cards |
| tcgplayer_market | decimal nullable | |
| ebay_avg_sold | decimal nullable | |
| recorded_at | timestamp | |

Retention: full hourly snapshots for 30 days; daily snapshots only beyond 30 days; purge after 90 days via nightly cron.

### 4.8 `sales` + `sale_items`
| Field | Type | Notes |
|---|---|---|
| sale.id | integer PK | |
| sale.staff_id | integer FK | → staff |
| sale.subtotal | decimal | before discount |
| sale.discount_amount | decimal | £ value, default 0 |
| sale.vat_amount | decimal | calculated at time of sale |
| sale.vat_scheme | text | `standard` or `margin` |
| sale.total | decimal | final amount charged |
| sale.payment_method | text | `cash`, `card`, `store_credit`, `other` |
| sale.created_at | timestamp | |
| sale_item.id | integer PK | |
| sale_item.sale_id | integer FK | → sales |
| sale_item.inventory_item_id | integer FK nullable | → inventory_items |
| sale_item.graded_card_id | integer FK nullable | → graded_cards |
| sale_item.bundle_id | integer FK nullable | → bundles |
| sale_item.quantity | integer | |
| sale_item.price_at_sale | decimal | snapshot — never changes |

### 4.9 `buylist_entries`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK | → cards |
| graded_card_id | integer FK nullable | → graded_cards (if buying a slab) |
| staff_id | integer FK | → staff |
| condition | text | NM/LP/MP/HP/DMG (raw cards only) |
| quantity | integer | |
| buy_price | decimal | per card |
| payment_method | text | `cash` or `store_credit` |
| want_list_match | boolean | true if card was on want list at time of purchase |
| created_at | timestamp | |

### 4.10 `want_list`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| card_id | integer FK | → cards |
| target_buy_price | decimal | |
| max_quantity | integer | |
| notes | text nullable | e.g. `NM only`, `any language` |
| is_active | boolean | |

### 4.11 `bundles`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| name | text | e.g. `Mystery Pack — 5 commons + 1 rare` |
| sell_price | decimal | |
| is_active | boolean | |

### 4.12 `bundle_items`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| bundle_id | integer FK | → bundles |
| inventory_item_id | integer FK | → inventory_items |
| quantity | integer | |

### 4.13 `store_credit_vouchers`
| Field | Type | Notes |
|---|---|---|
| id | integer PK | |
| code | text UNIQUE | generated alphanumeric code, printed for customer |
| amount | decimal | |
| is_redeemed | boolean | |
| redeemed_at | timestamp nullable | |
| redeemed_in_sale_id | integer FK nullable | → sales |
| issued_in_buylist_id | integer FK nullable | → buylist_entries |
| created_at | timestamp | |

### 4.14 `offline_write_queue`
Stores writes made while offline, applied in order on reconnect.

| Field | Type | Notes |
|---|---|---|
| id | text | UUID |
| action | text | `sale`, `buylist`, `stock_adjust` etc. |
| payload | text | JSON |
| created_at | timestamp | |
| synced_at | timestamp nullable | null = pending |
| conflict | boolean | true if server flagged a conflict |

---

## 5. Pricing

### 5.0 Card Image Sources

Images are fetched once when a card is first added to the catalog and stored in `cards.image_url` / `cards.image_url_large`. They are not re-fetched on every price sync. All primary image sources are available from day one — no partner approval required.

| Game | Primary Source | Approval Needed |
|---|---|---|
| Pokemon | Pokemon TCG API (`images.small`, `images.large`) | No — free API key |
| MTG | Scryfall API (`image_uris.normal`, `image_uris.large`) | No — fully open |
| Yu-Gi-Oh | YGOProDeck API | No — fully open |
| Any game | PriceCharting API | No — paid API key only |
| Other games | Manual upload → Vercel Blob | N/A |
| All games (future) | TCGPlayer API images | Yes — add once partner access approved; not a blocker |

**Offline image strategy:** Morning sync downloads and caches reference images for all in-stock cards into the service worker cache. Zero-stock cards are excluded. High-value card condition photos (Vercel Blob) are pre-cached separately. Both images are shown on the card detail screen — the reference image (what the card looks like) and the condition photo (this specific copy's actual condition).

### 5.1 Raw Card Pricing Sources

**Phase 1 — Free, available immediately (build these first):**
| Source | Data Provided | Access |
|---|---|---|
| Pokemon TCG API | Pokemon card catalog + images + TCGPlayer market/low/mid/high prices embedded | Free API key — no approval |
| Scryfall | MTG card catalog + images + prices | Fully open — no key needed |
| YGOProDeck | Yu-Gi-Oh catalog + images + prices | Fully open — no key needed |

Phase 1 delivers a fully working product with real prices and real images at zero cost.

**Phase 2 — Paid/approval required, add later:**
| Source | Data Provided | Access |
|---|---|---|
| PriceCharting API | Loose/graded/complete prices across all games | Paid API key — no approval process |
| TCGPlayer API | Direct market/low/high prices + images | Partner approval required |
| eBay Browse API | Sold listing averages | Partner approval required |

### 5.2 Graded Card Pricing Sources
| Source | Purpose | Access |
|---|---|---|
| Card Ladder API | PSA/BGS/CGC aggregate prices | Confirm access before building |
| eBay (grade filter) | Sold listings by grade | Same approval as above |

Fallback: manual sell price entry until API access is confirmed.

### 5.3 Sync Schedule
| Cron | Time | Action |
|---|---|---|
| Morning deep sync | 07:00 daily | Full refresh of all cards in inventory |
| Hourly sync | Every hour | Background refresh |
| Evening sweep | 18:00 daily | End-of-day refresh |
| History cleanup | 02:00 daily | Enforce price_history retention policy |
| On-demand | Any time | "Refresh Price" button on any card detail screen |

### 5.4 High-Value Flag
- Configurable threshold (default £50), set by admin
- Cards above threshold: stale warning shown after 4 hours since last sync
- Morning sync pre-caches condition photos for flagged items into service worker
- "Refresh Price" button is always visible on all cards; more prominent on flagged cards

### 5.5 Sell Price Calculation
Priority order:
1. `sell_price_override` on inventory_item (if set)
2. `price_cache.tcgplayer_market × margin_multiplier` (configurable, default 85%)
3. Manual entry if no price cache exists

### 5.6 Buylist Price Suggestion
`price_cache.tcgplayer_market × buylist_percentage` (configurable, default 50%)
Always editable by staff. Graded card buy prices are always manual — no auto-suggestion.

### 5.7 VAT (UK)
- Standard rate: 20% on new sealed product and accessories
- Margin scheme: VAT on profit margin only — applicable to second-hand singles
- Scheme toggleable per product category by admin
- Confirm with accountant before enabling margin scheme
- VAT amount and scheme stored per sale for reporting

---

## 6. Offline Strategy

> **Descoped 2026-07-02, implemented 2026-07-05:** the PWA/service-worker/IndexedDB design below was superseded by the minimal offline sale queue in `2026-07-02-risk-fixes-design.md` (Package D) — `sales.client_uuid` idempotency + a localStorage checkout queue with human-resolved conflicts. This section is kept for historical context only.

The server (Vercel Fluid Compute) always communicates with Turso cloud. There is no server-side local replica.

Offline support is entirely browser-side:
- **Service worker** caches the app shell, UI assets, and recent API responses
- **IndexedDB** stores: current inventory snapshot, price cache, pending write queue
- POS can complete sales, look up cards, and display prices while offline
- Writes (sales, buylist entries, stock adjustments) are queued in IndexedDB (browser-side); a mirror `offline_write_queue` table in Turso tracks sync status server-side
- On reconnect: queued writes sent to server in timestamp order
- Conflicts (e.g. stock went negative) are flagged on the dashboard for admin review — never auto-resolved

Morning sync pre-caches condition photos and card reference images (for all in-stock cards) into the service worker. Zero-stock and low-stock cards below threshold are excluded to keep the cache lean.

---

## 7. Hardware

| Hardware | Purpose | Approx. Cost |
|---|---|---|
| USB QR scanner | Scan QR labels at POS | ~£20 |
| Brother label printer | Print QR stickers for singles | ~£30 |
| Thermal receipt printer (80mm) | Customer receipts | ~£40 (optional) |
| Payment terminal | Card payments | TBD — pluggable integration |

QR codes are generated per inventory item (UUID-based). Labels printed via Brother SDK or browser print dialog. Barcode scanning still supported for sealed products with standard UPC/EAN barcodes.

---

## 8. Key Flows

### 8.1 Sale Flow
1. Staff enters PIN → session opened
2. QR scan or manual search (name, set, set number)
3. Card/product detail shown: image, condition, stock, sell price, TCGPlayer + eBay reference prices, trend indicator
4. High-value flag shown if applicable; Refresh Price button always visible
5. Select condition + quantity → add to cart; bundles selectable as a single cart item
6. Repeat for multiple items
7. Apply optional discount (£ or %)
8. VAT calculated; payment method selected (cash / card / store credit voucher / other)
9. If store credit: staff enters voucher code → system validates code, deducts from total, marks voucher as redeemed
10. Confirm → inventory decremented, sale recorded with staff ID, receipt offered (browser print dialog or thermal printer)

### 8.2 Buylist Flow (Buying from Customer)
1. Staff searches card (name/set)
2. System auto-checks want list → shows match badge if found ("Shop wants this — target: £X")
3. Select condition; suggested buy price shown (TCGPlayer × buylist %)
4. Staff edits buy price if needed
5. If card value > threshold: condition photo required
6. Select payment: cash or store credit voucher (store credit offers higher value)
7. Confirm → buylist entry recorded, card added to inventory, QR label print prompt shown

### 8.3 Graded Card Buylist (Admin Only)
1. Enter cert number → Card Ladder + eBay prices fetched automatically
2. Card details and population shown
3. Admin reviews pricing; sets buy price manually
4. Condition photo required before confirming
5. Confirm → graded_card record created, buylist entry recorded

### 8.4 Bulk Import Flow
1. Admin downloads CSV template (name, set, number, condition, qty, cost_price)
2. Upload CSV
3. System fuzzy-matches rows to card catalog via API
4. Ambiguous matches presented for manual confirmation; unmatched rows held separately
5. Admin confirms all matches
6. Inventory updated in bulk; QR labels generated for batch printing

---

## 9. UI Screens

| Screen | Access | Description |
|---|---|---|
| PIN Login | All | Staff PIN entry at start of session |
| POS / Checkout | Staff + Admin | Main selling screen with QR/manual search, cart, checkout |
| Card Detail | Staff + Admin | Image, prices, trend, condition stock, Refresh button |
| Inventory Manager | Staff + Admin | Browse, search, adjust stock; add new items |
| Add / Edit Item | Staff + Admin | Add card, product, graded card; generate QR label |
| Bulk Import | Admin | CSV upload and match review |
| Graded Cards | Staff + Admin | Dedicated view for graded slab inventory |
| Buylist | Staff + Admin | Buy cards from customers |
| Want List | Admin (edit) / Staff (view) | Cards the shop is seeking to buy |
| Bundle Builder | Admin | Create sellable bundles from inventory |
| Store Credit | Admin | Issue and redeem credit vouchers |
| Reports | Admin | Sales, margins, buylist spend, inventory valuation |
| Till Reconciliation | Admin | End-of-day cash count vs. expected |
| Settings | Admin | Pricing rules, VAT scheme, thresholds, staff management |

---

## 10. Reporting

| Report | Description |
|---|---|
| Daily sales summary | Total by payment method, by staff member |
| Sales history | Filterable by date range, game, staff, card |
| Margin report | Cost vs. sell price per item and category |
| Inventory valuation | Current stock valued at market price (insurance report) |
| Buylist spend | Total spent buying cards, by date range and staff |
| Price trend | ↑↓ indicator vs. last week per card (from price_history) |
| Low stock alerts | Items at or below low_stock_threshold |
| Till reconciliation | Expected vs. counted cash; card terminal total; variance |
| Staff accountability | All actions by staff member with timestamps |

---

## 11. Staff Roles & Permissions

| Action | Admin | Staff |
|---|---|---|
| POS — sell cards | ✓ | ✓ |
| Apply discount at checkout | ✓ | ✓ |
| Inventory — view + stock adjust | ✓ | ✓ |
| Inventory — add new items | ✓ | ✓ |
| Inventory — delete items | ✓ | ✗ |
| Buylist — raw cards | ✓ | ✓ |
| Buylist — graded cards (confirm) | ✓ | ✗ |
| Want list — edit | ✓ | ✗ |
| Want list — view | ✓ | ✓ |
| Bundle builder | ✓ | ✗ |
| Store credit — issue + redeem | ✓ | ✗ |
| Reports (full) | ✓ | ✗ |
| Today's sales summary | ✓ | ✓ |
| Till reconciliation | ✓ | ✗ |
| Settings + config | ✓ | ✗ |
| Manage staff | ✓ | ✗ |

---

## 12. Open Items (Pre-Build Confirmations Needed)

| Item | Action Required |
|---|---|
| Phase 1 APIs (Pokemon TCG, Scryfall, YGOProDeck) | Free — get API keys before starting build |
| PriceCharting API key | Purchase when ready — Phase 2 |
| TCGPlayer API partner access | Apply when ready — Phase 2 |
| eBay Marketplace Insights API | Apply; build eBay integration as optional/pluggable |
| Card Ladder API access | Confirm availability; build graded pricing with manual fallback |
| VAT scheme (standard vs. margin) | Confirm with accountant which applies to singles |
| Payment terminal brand | TBD — wire in after initial build |
| Brother label printer model | Confirm for SDK integration |

---

## 13. Out of Scope (v1)

- Customer accounts / loyalty points
- Online shop / e-commerce storefront
- TCGPlayer / eBay automatic listing push (design for it, build later)
- Tournament / event management (design for it, build later)
- Multi-location support
- Consignment tracking
- Competitor price monitoring
