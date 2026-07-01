# Cardmarket Prices (alongside TCGplayer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Cardmarket (European) market prices — the reference UK customers actually use — alongside the existing TCGplayer prices, in GBP, and let the shop choose which source drives auto sell-prices.

**Architecture:** Add Cardmarket price columns to `price_cache`. Source the data from **TCGdex** (`api.tcgdex.net/v2`) — free, no API key, Cardmarket EUR prices, and its card IDs are our existing `cards.externalId` lowercased (e.g. `base1-4`, `sv1-6`), so no fuzzy matching is needed. Prices are fetched best-effort when a card is first seen and refreshed by a nightly sync job; EUR is converted to GBP with a configurable rate (mirroring the existing USD→GBP mechanism). A new `settings.primaryPriceSource` decides whether sell-prices derive from Cardmarket or TCGplayer.

**Tech Stack:** Next.js 16 App Router, Turso (libSQL) + Drizzle, TCGdex REST API, Tailwind v4 + shadcn/ui.

## Global Constraints

- Node 24 LTS; Next.js 16 App Router only; TypeScript strict.
- All money is SQLite `real`, GBP, rounded to 2dp at write time.
- **Cardmarket prices are stored already converted to GBP** in `price_cache` (consistent with how TCGplayer prices are already stored in GBP). The raw source currency is EUR.
- TCGdex card id = `cards.externalId.toLowerCase()`. Never invent a different join key.
- TCGdex is a free community API with no SLA: every call is wrapped so a failure degrades gracefully (skip, keep stale data) — it must never throw a 500 into a user request.
- Conversion rate lives in `settings` (`eurToGbp`), defaulting to env `PRICE_EUR_TO_GBP` then `0.86`. Mirrors the existing `usdToGbp` helper in `lib/pricing.ts`.
- **Verification:** no unit-test runner; verify via `npx tsc --noEmit` (clean) plus the concrete `npx tsx --env-file=.env.local scripts/<name>.ts` or `curl` check named in each task.
- Migrations: `npx drizzle-kit generate` then apply with env exported. `.env.local` gitignored.
- Reuse: `getSettings`/`updateSettings` (`lib/settings.ts`), `usdToGbp`/`formatGBP`/`calculateSellPrice` (`lib/pricing.ts`), `db`, `getSession`.

---

## File Structure

- `lib/db/schema.ts` — add `cardmarketTrend`, `cardmarketLow`, `cardmarketAvg`, `cardmarketSyncedAt` to `price_cache`; add `eurToGbp` + `primaryPriceSource` to `settings`.
- `lib/settings.ts` — extend `AppSettings` + defaults + `toAppSettings`.
- `lib/pricing.ts` — add `eurToGbp(eur, rate?)`; add `pickMarketPrice(prices, source)` helper that returns the right "market" number for sell-price math.
- `lib/apis/tcgdex.ts` — `fetchCardmarketPrices(externalId, variant)` → `{ trend, low, avg }` in **EUR** or `null`.
- `lib/prices/sync.ts` — `syncCardmarketForCard(cardId, externalId, variant, eurRate, highValueThreshold)` shared by the search insert path, the backfill script and the cron route.
- `app/api/cron/sync-prices/route.ts` — nightly refresh of in-stock cards (CRON_SECRET-guarded).
- `scripts/sync-cardmarket.ts` — one-off/manual backfill of all cards.
- `app/api/cards/search/route.ts` — best-effort Cardmarket fetch when inserting a new card.
- `components/pos/CardResult.tsx`, `components/inventory/InventoryTable.tsx`, `app/(app)/prices/page.tsx` — show Cardmarket alongside TCGplayer.
- `components/settings/SettingsForm.tsx` + `app/api/settings/route.ts` — edit `eurToGbp` and `primaryPriceSource`.

---

## Task 1: Schema — Cardmarket columns + settings

**Files:**
- Modify: `lib/db/schema.ts`
- Create: migration via drizzle-kit

**Interfaces:**
- Produces: `priceCache.cardmarketTrend|cardmarketLow|cardmarketAvg|cardmarketSyncedAt`; `settings.eurToGbp` (real, default 0.86), `settings.primaryPriceSource` (text, default `'cardmarket'`).

- [ ] **Step 1:** In `price_cache` (after `tcgplayerHigh`) add:

```ts
  cardmarketTrend: real('cardmarket_trend'),
  cardmarketLow: real('cardmarket_low'),
  cardmarketAvg: real('cardmarket_avg'),
  cardmarketSyncedAt: text('cardmarket_synced_at'),
```

- [ ] **Step 2:** In `settings` (after `highValueThreshold`) add:

```ts
  eurToGbp: real('eur_to_gbp').notNull().default(0.86),
  primaryPriceSource: text('primary_price_source').notNull().default('cardmarket'), // 'cardmarket' | 'tcgplayer'
```

- [ ] **Step 3:** `npx drizzle-kit generate`; expected: ALTERs adding 4 columns to `price_cache` and 2 to `settings`. Apply with `npx drizzle-kit migrate` (env exported). Expected: `migrations applied successfully!`.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add lib/db/schema.ts lib/db/migrations
git commit -m "feat: Cardmarket price columns + EUR rate / source settings"
```

---

## Task 2: Settings + pricing helpers

**Files:**
- Modify: `lib/settings.ts`, `lib/pricing.ts`

**Interfaces:**
- Produces: `AppSettings.eurToGbp: number`, `AppSettings.primaryPriceSource: 'cardmarket' | 'tcgplayer'`; `eurToGbp(eur, rate?): number | null`; `pickMarketPrice(prices, source): number | null`.
- Consumes: existing `PriceCache` type.

- [ ] **Step 1:** Extend `lib/settings.ts`: add `eurToGbp` and `primaryPriceSource` to `AppSettings`; to `DEFAULT_SETTINGS` (`eurToGbp: parseFloat(process.env.PRICE_EUR_TO_GBP ?? '0.86') || 0.86`, `primaryPriceSource: 'cardmarket'`); and to `toAppSettings`.

- [ ] **Step 2:** In `lib/pricing.ts` add, mirroring `usdToGbp`:

```ts
export function eurToGbp(
  eur: number | null | undefined,
  rate = parseFloat(process.env.PRICE_EUR_TO_GBP ?? process.env.NEXT_PUBLIC_EUR_TO_GBP ?? '0.86') || 0.86
): number | null {
  if (eur == null) return null
  return Math.round(eur * rate * 100) / 100
}

// Pick the "market" price that drives sell-price math, per shop setting.
// Both inputs are already GBP. Falls back to the other source if the chosen one is missing.
export function pickMarketPrice(
  prices: { tcgplayerMarket?: number | null; cardmarketTrend?: number | null } | null | undefined,
  source: 'cardmarket' | 'tcgplayer'
): number | null {
  if (!prices) return null
  const cm = prices.cardmarketTrend ?? null
  const tcg = prices.tcgplayerMarket ?? null
  return source === 'cardmarket' ? (cm ?? tcg) : (tcg ?? cm)
}
```

- [ ] **Step 3: Verify** with `scripts/_verify-eur.ts`:

```ts
import { eurToGbp, pickMarketPrice } from '../lib/pricing'
console.log('10 EUR @0.86 (expect 8.6):', eurToGbp(10, 0.86))
console.log('null (expect null):', eurToGbp(null))
console.log('pick cardmarket (expect 5):', pickMarketPrice({ tcgplayerMarket: 9, cardmarketTrend: 5 }, 'cardmarket'))
console.log('pick fallback (expect 9):', pickMarketPrice({ tcgplayerMarket: 9, cardmarketTrend: null }, 'cardmarket'))
```

Run: `npx tsx scripts/_verify-eur.ts`
Expected: `8.6`, `null`, `5`, `9`. Then `rm scripts/_verify-eur.ts`.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add lib/settings.ts lib/pricing.ts
git commit -m "feat: EUR->GBP helper and price-source picker"
```

---

## Task 3: TCGdex client

**Files:**
- Create: `lib/apis/tcgdex.ts`

**Interfaces:**
- Produces: `fetchCardmarketPrices(externalId: string, variant?: string | null): Promise<{ trend: number|null; low: number|null; avg: number|null } | null>` — values in **EUR**; returns `null` on any failure or when the card/pricing is absent. Picks holo fields when `variant` indicates a holo/reverse printing.
- Consumes: nothing internal.

- [ ] **Step 1:** Write `lib/apis/tcgdex.ts`:

```ts
const BASE = 'https://api.tcgdex.net/v2/en'

interface TcgdexCardmarket {
  unit?: string
  trend?: number; low?: number; avg?: number
  'trend-holo'?: number; 'low-holo'?: number; 'avg-holo'?: number
}

function isHolo(variant?: string | null): boolean {
  if (!variant) return false
  const v = variant.toLowerCase()
  return v.includes('holo') || v.includes('gx') || v.includes('ex') || v.includes('vmax') || v.includes('vstar') || v.includes('v ')
}

export async function fetchCardmarketPrices(
  externalId: string,
  variant?: string | null,
): Promise<{ trend: number | null; low: number | null; avg: number | null } | null> {
  try {
    const id = externalId.toLowerCase()
    const res = await fetch(`${BASE}/cards/${encodeURIComponent(id)}`, { next: { revalidate: 86400 } })
    if (!res.ok) return null
    const data = await res.json()
    const cm: TcgdexCardmarket | undefined = data?.pricing?.cardmarket
    if (!cm) return null
    const holo = isHolo(variant)
    return {
      trend: (holo ? cm['trend-holo'] : cm.trend) ?? cm.trend ?? null,
      low: (holo ? cm['low-holo'] : cm.low) ?? cm.low ?? null,
      avg: (holo ? cm['avg-holo'] : cm.avg) ?? cm.avg ?? null,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Verify** against a real card. `scripts/_verify-tcgdex.ts`:

```ts
import { fetchCardmarketPrices } from '../lib/apis/tcgdex'
async function main() {
  const r = await fetchCardmarketPrices('base1-4', 'Holo Rare') // Charizard base set
  console.log('base1-4 cardmarket (EUR):', r)
  const bad = await fetchCardmarketPrices('not-a-real-id')
  console.log('bad id (expect null):', bad)
  process.exit(0)
}
main()
```

Run: `npx tsx scripts/_verify-tcgdex.ts`
Expected: a non-null `{ trend, low, avg }` with numbers for `base1-4` (Charizard has real Cardmarket data); `null` for the bad id. Then `rm scripts/_verify-tcgdex.ts`. (If TCGdex is briefly down the first line may be `null` — re-run; the test passes if the bad-id line is `null` and a known-good id returns numbers when the service is up.)

- [ ] **Step 3:** `npx tsc --noEmit` clean; commit.

```bash
git add lib/apis/tcgdex.ts
git commit -m "feat: TCGdex client for Cardmarket EUR prices"
```

---

## Task 4: Shared sync function + best-effort fetch on card insert

**Files:**
- Create: `lib/prices/sync.ts`
- Modify: `app/api/cards/search/route.ts`

**Interfaces:**
- Produces: `syncCardmarketForCard(cardId: number, externalId: string, variant: string | null, eurRate: number): Promise<void>` — fetches TCGdex, converts EUR→GBP, updates the card's `price_cache` row (`cardmarketTrend/Low/Avg`, `cardmarketSyncedAt`). Best-effort: never throws.
- Consumes: `fetchCardmarketPrices`, `eurToGbp`, `db`, `priceCache`.

- [ ] **Step 1:** Write `lib/prices/sync.ts`:

```ts
import { db } from '@/lib/db'
import { priceCache } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { fetchCardmarketPrices } from '@/lib/apis/tcgdex'
import { eurToGbp } from '@/lib/pricing'

export async function syncCardmarketForCard(
  cardId: number, externalId: string | null, variant: string | null, eurRate: number,
): Promise<void> {
  if (!externalId) return
  const cm = await fetchCardmarketPrices(externalId, variant)
  if (!cm) return
  try {
    await db.update(priceCache).set({
      cardmarketTrend: eurToGbp(cm.trend, eurRate),
      cardmarketLow: eurToGbp(cm.low, eurRate),
      cardmarketAvg: eurToGbp(cm.avg, eurRate),
      cardmarketSyncedAt: new Date().toISOString(),
    }).where(eq(priceCache.cardId, cardId))
  } catch { /* price row may not exist yet; ignore */ }
}
```

- [ ] **Step 2:** In `app/api/cards/search/route.ts`, after a new card + its `priceCache` row are inserted (inside `insertCardSafely`, after the priceCache insert succeeds), call the sync best-effort. Pass the EUR rate from `settings` (already fetched in the route). Because it's best-effort and we don't want to slow search, fire it without blocking the response is risky on serverless — instead `await` it but it's a single fast call already wrapped in try/catch returning null fast on failure. Add inside `insertCardSafely(apiCard, threshold, usdRate, eurRate)`:

```ts
await syncCardmarketForCard(card.id, card.externalId, card.variant, eurRate)
```

Update the call site to pass `settings.eurToGbp`.

- [ ] **Step 3: Verify:** with dev server running and logged in, search a card not yet in the DB (e.g. a less common name), then query its `price_cache` via a quick script or the Price Lookup — `cardmarket_trend` should be populated (GBP) within the search response cycle. Acceptable if occasionally null (TCGdex miss); the backfill (Task 5) covers gaps.

- [ ] **Step 4:** `npx tsc --noEmit` clean; commit.

```bash
git add lib/prices/sync.ts app/api/cards/search/route.ts
git commit -m "feat: best-effort Cardmarket sync on card insert"
```

---

## Task 5: Backfill script + nightly cron route

**Files:**
- Create: `scripts/sync-cardmarket.ts` (keep — operational tool)
- Create: `app/api/cron/sync-prices/route.ts`

**Interfaces:**
- `scripts/sync-cardmarket.ts`: iterates **all** cards, calls `syncCardmarketForCard`, logs counts. Run manually: `npx tsx --env-file=.env.local scripts/sync-cardmarket.ts`.
- `GET /api/cron/sync-prices`: refreshes Cardmarket prices for cards that currently have **active inventory** (the prices that matter), guarded by `Authorization: Bearer ${CRON_SECRET}`.

- [ ] **Step 1:** `scripts/sync-cardmarket.ts`:

```ts
import { db } from '../lib/db'
import { cards } from '../lib/db/schema'
import { getSettings } from '../lib/settings'
import { syncCardmarketForCard } from '../lib/prices/sync'

async function main() {
  const settings = await getSettings()
  const all = await db.select().from(cards)
  let ok = 0
  for (const c of all) {
    await syncCardmarketForCard(c.id, c.externalId, c.variant, settings.eurToGbp)
    ok++
    if (ok % 25 === 0) console.log(`synced ${ok}/${all.length}`)
    await new Promise(r => setTimeout(r, 120)) // be gentle on the free API
  }
  console.log(`done: ${ok}/${all.length}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2:** `app/api/cron/sync-prices/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cards, inventoryItems } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { getSettings } from '@/lib/settings'
import { syncCardmarketForCard } from '@/lib/prices/sync'

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const settings = await getSettings()
  const inStock = await db.selectDistinct({ id: cards.id, externalId: cards.externalId, variant: cards.variant })
    .from(cards)
    .innerJoin(inventoryItems, and(eq(inventoryItems.cardId, cards.id), eq(inventoryItems.isActive, true)))
  let ok = 0
  for (const c of inStock) { await syncCardmarketForCard(c.id, c.externalId, c.variant, settings.eurToGbp); ok++ }
  return NextResponse.json({ synced: ok })
}
```

- [ ] **Step 3:** Add `CRON_SECRET=<random hex>` to `.env.local`. At deploy, wire a Vercel cron in `vercel.ts`:

```ts
crons: [{ path: '/api/cron/sync-prices', schedule: '0 3 * * *' }],
```

(Document this; Vercel calls the path daily at 03:00 with the project's deployment auth — for the secret-guarded route, set the cron to call with the header via a Vercel cron + `CRON_SECRET` env, per Vercel docs. Local verification uses curl below.)

- [ ] **Step 4: Verify:** run the backfill on seeded data: `npx tsx --env-file=.env.local scripts/seed-cards.ts` (if not already seeded) then `npx tsx --env-file=.env.local scripts/sync-cardmarket.ts` — expect `done: N/N`. Then with dev server running: `curl -s -H "authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" localhost:3000/api/cron/sync-prices` → `{"synced":<count of in-stock cards>}`.

- [ ] **Step 5:** `npx tsc --noEmit` clean; commit.

```bash
git add scripts/sync-cardmarket.ts app/api/cron/sync-prices
git commit -m "feat: Cardmarket backfill script + nightly cron route"
```

---

## Task 6: Show Cardmarket prices in the UI + drive sell-price from the chosen source

**Files:**
- Modify: `components/pos/CardResult.tsx`, `components/inventory/InventoryTable.tsx`, `app/(app)/prices/page.tsx`, `components/shared/CardZoomModal.tsx`
- Modify: `app/api/settings/route.ts`, `components/settings/SettingsForm.tsx`

**Interfaces:**
- Consumes: `priceCache.cardmarketTrend/Low/Avg`, `useSettings().primaryPriceSource`, `pickMarketPrice`, `formatGBP`.
- Behaviour: every place that currently shows `tcgplayerMarket` also shows `Cardmarket (trend)`; sell-price math switches from hard-coded `tcgplayerMarket` to `pickMarketPrice(prices, primaryPriceSource)`.

- [ ] **Step 1: Settings.** In `app/api/settings/route.ts` add `eurToGbp` to the numeric loop and accept `primaryPriceSource` (validate `=== 'cardmarket' || === 'tcgplayer'`). In `SettingsForm.tsx` add a EUR→GBP input and a two-button source toggle (Cardmarket / TCGplayer), with a worked example showing the resulting sell price from each source.

- [ ] **Step 2: CardResult (POS).** Replace `calculateSellPrice(prices?.tcgplayerMarket, …)` with `calculateSellPrice(pickMarketPrice(prices, primaryPriceSource), …)` (read `primaryPriceSource` from `useSettings()`). Add a `Badge` "CM £{formatGBP(prices?.cardmarketTrend)}" next to the existing TCG badge.

- [ ] **Step 3: InventoryTable.** Same swap for `sellPrice`, and add a "Cardmarket" column (or a second line under TCG Market) showing `formatGBP(prices?.cardmarketTrend)`.

- [ ] **Step 4: Price Lookup.** The live `/prices` search uses the Pokémon TCG API (TCGplayer). Add a per-result lazy Cardmarket fetch: for each rendered `CardPriceRow`, call `fetch('/api/prices/cardmarket?id=' + card.id)` (a tiny new route wrapping `fetchCardmarketPrices` + `eurToGbp` server-side) and show a "Cardmarket (GBP)" block beside the TCGplayer variants. Create `app/api/prices/cardmarket/route.ts` (`GET ?id=` → `{ trend, low, avg }` GBP, staffId-guarded). Keep it best-effort with a small "—" when null.

- [ ] **Step 5: CardZoomModal.** Add an optional `cardmarketTrend` to `CardZoomData` and show it under the TCG market line.

- [ ] **Step 6: Verify in browser:** after running the backfill, open Inventory and POS — Cardmarket prices appear next to TCGplayer; switch `primaryPriceSource` to Cardmarket in Settings and confirm sell prices change accordingly; Price Lookup shows both sources for a searched card.

- [ ] **Step 7:** `npx tsc --noEmit` clean; commit.

```bash
git add components app/(app)/prices app/api/prices/cardmarket app/api/settings/route.ts
git commit -m "feat: show Cardmarket prices and drive sell-price from chosen source"
```

---

## Self-Review Notes

- **Join key correctness:** TCGdex id = `externalId.toLowerCase()`; verified concretely in Task 3. ✓
- **Resilience:** every TCGdex call is wrapped to return `null` on failure; sync never throws into a user request. ✓
- **Currency:** Cardmarket EUR is converted to GBP at write time (Tasks 4–5) and stored in GBP, consistent with TCGplayer columns; UI never re-converts. ✓
- **Source choice flows end to end:** `primaryPriceSource` set in Settings → `pickMarketPrice` → `calculateSellPrice` in POS + Inventory (Task 6). ✓
- Type/name consistency: `fetchCardmarketPrices`, `syncCardmarketForCard`, `eurToGbp`, `pickMarketPrice` defined in Tasks 2–4 and used by name thereafter. ✓
- Out of scope (noted): graded-card Cardmarket pricing (graded markets differ); historical price charts (`avg1/7/30` are available from TCGdex if wanted later); holo detection is heuristic and can be refined per-set.
