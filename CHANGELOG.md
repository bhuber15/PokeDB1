# Changelog

Newest first, dated by merge to `main`. The app is continuously deployed, so there are no version numbers — dates and PRs are the units of change. Entries that ship a DB migration say so, because **deploys do not auto-migrate**: someone has to run `npx drizzle-kit migrate` against the live DB (see README → Migrations).

This file was reconstructed on 2026-07-26 from the git history and merged PRs of [bhuber15/PokeDB1](https://github.com/bhuber15/PokeDB1). Keep it current: add a line under a dated heading when a PR merges.

## Unreleased — branch `fix/migration-drift-visibility`

- Dev server warns on boot when the DB is behind the checked-in migrations (`lib/db/migration-drift.ts`)
- `getSettings` never silently falls back to `DEFAULT_SETTINGS` (root cause of the 2026-07-25 demo failure)
- `import-catalogue --only=<games>` to import just-enabled games without re-sweeping Pokémon
- Gitignore the local MTG/YGO sandbox DB

## 2026-07-26 — docs

- **Comprehensive README, annotated repo treeview, and this changelog** ([#45](https://github.com/bhuber15/PokeDB1/pull/45))

## 2026-07-26 — audit close-out

The last two of four PRs fixing the 2026-07-25 full-code audit (15 findings):

- **Refund/void audit fixes** — store-credit refunds, void race, BST day-window, voided sales in history ([#41](https://github.com/bhuber15/PokeDB1/pull/41))
- **Performance** — cache the fuzzy-search name list, index hot FK columns, bound platform maps ([#44](https://github.com/bhuber15/PokeDB1/pull/44)) — *migration `0024_perf-indexes`*

## 2026-07-25

- **Security hardening** — staff price gate, tenant-safe owner login, impersonation transaction bar, PIN collisions, constant-time cron auth ([#43](https://github.com/bhuber15/PokeDB1/pull/43))
- **Intake and POS robustness** — inventory intake atomicity, buy price validation, POS search error handling ([#42](https://github.com/bhuber15/PokeDB1/pull/42))

## 2026-07-24 — Magic and Yu-Gi-Oh!

- **Multi-game phase 2: MTG + Yu-Gi-Oh! singles** ([#38](https://github.com/bhuber15/PokeDB1/pull/38)) — *migration `0023_multi-game-mtg-ygo`*. Scryfall and YGOPRODeck catalogue sources; per-shop game gating via Settings → Games; game filters across POS/inventory/buylist.
- **Fix MTG/YGO card images and game-selector overflow** ([#39](https://github.com/bhuber15/PokeDB1/pull/39))

## 2026-07-23

- **Multi-language Pokémon catalogue, phase 1** — JP/KO/ZH singles plus a no-price workflow ([#37](https://github.com/bhuber15/PokeDB1/pull/37)) — *migration `0022_multilang-pokemon`*

## 2026-07-22 — first-shop demo fixes

Click-testing fallout from the first in-shop demo, same day:

- **Condition-based pricing** — per-condition ladder scales market price everywhere it surfaces; opt-in preset in Settings ([#36](https://github.com/bhuber15/PokeDB1/pull/36)) — *migration `0021`*
- **POS/buylist UX** — honest price-age badge, live stock counts after a sale, scanner-safe search focus ([#33](https://github.com/bhuber15/PokeDB1/pull/33))
- **Zero-price cache fix** — cached 0 is "no data", not a price ([#34](https://github.com/bhuber15/PokeDB1/pull/34))
- **Inventory add** — URL-driven Card/Product toggle, clicks work pre-hydration ([#35](https://github.com/bhuber15/PokeDB1/pull/35))

## 2026-07-20

- **Products (non-card SKUs)** — sell sealed, accessories and snacks at the till ([#32](https://github.com/bhuber15/PokeDB1/pull/32)) — *migration `0020`*

## 2026-07-18 — Phase 4 shop backlog (F5–F11) + platform ops

Seven shop features in one wave:

- **F5: cash-up close record** ([#20](https://github.com/bhuber15/PokeDB1/pull/20)) — *migration `0017_cash-ups`*
- **F6: split tender / partial payments** ([#23](https://github.com/bhuber15/PokeDB1/pull/23)) — *migration `0019_sale-payments`*
- **F7: void a sale** — same-day full reversal, distinct from refund ([#22](https://github.com/bhuber15/PokeDB1/pull/22)) — *migration `0018_sale-voids`*
- **F8: cost/margin role-gating** — cost basis is admin-only ([#26](https://github.com/bhuber15/PokeDB1/pull/26))
- **F9: reporting extras** — valuation, dead stock, reorder list, staff margin, buys CSV ([#29](https://github.com/bhuber15/PokeDB1/pull/29))
- **F10: POS live price refresh** wired to the on-demand endpoint ([#27](https://github.com/bhuber15/PokeDB1/pull/27))
- **F11: email receipts + sales history search** ([#25](https://github.com/bhuber15/PokeDB1/pull/25))
- **Fix: dead unique-violation catch in the createSale replay race** ([#28](https://github.com/bhuber15/PokeDB1/pull/28))

Plus the platform:

- **Platform Phase 3: ops** — admin dashboard with audited impersonation, staggered tenant crons, hourly backups, rate limits, full-shop export, env-gated observability ([#24](https://github.com/bhuber15/PokeDB1/pull/24)) — *platform migration `0002_impersonation-grants`*
- **Docs: Wizard-of-Oz runbook update** for F11 email, backups, vercel.json crons ([#31](https://github.com/bhuber15/PokeDB1/pull/31))

## 2026-07-17

- **Platform Phase 2: Stripe billing + automated provisioning** — Checkout, idempotent webhooks (`stripe_events`), plan entitlements, idempotent `provisionTenant` ([#19](https://github.com/bhuber15/PokeDB1/pull/19)) — *migration `0016_onboarding-state`, platform migration `0001_tenant-email`*

## 2026-07-14

- **Cardmarket coverage** — nightly catalogue rotation + on-demand buylist refresh, fixing USD-fallback buy prices ([#18](https://github.com/bhuber15/PokeDB1/pull/18))

## 2026-07-12

- **Platform foundation: multi-tenancy core behind `TENANCY_MODE`** (Phases 0–1) — tenant registry, subdomain routing in `proxy.ts`, `getTenantDb()` everywhere, tenancy guard test ([#17](https://github.com/bhuber15/PokeDB1/pull/17)) — *migration `0015`, platform migration `0000` (new registry DB)*

## 2026-07-11 — sellable backlog (F1–F4)

- **F1: staff management UI + API** ([#14](https://github.com/bhuber15/PokeDB1/pull/14))
- **F2: VAT Margin Scheme** for second-hand goods ([#16](https://github.com/bhuber15/PokeDB1/pull/16)) — *migration `0014`*
- **F3: customer-linked sales + purchase history** ([#13](https://github.com/bhuber15/PokeDB1/pull/13)) — *migration `0013`*
- **F4: wants in stock now** — proactive want-list surface + nav badge ([#15](https://github.com/bhuber15/PokeDB1/pull/15))

## 2026-07-09

- **Full-build review fixes** — security hardening, POS/inventory bugs, scrydex image host ([#12](https://github.com/bhuber15/PokeDB1/pull/12))

## 2026-07-06 — shop ops + catalogue browsing

- **Auth rate limiting** — DB-backed lockout for PIN and owner login ([#6](https://github.com/bhuber15/PokeDB1/pull/6)) — *migration `0010_auth-lockouts`*
- **Money-path guardrails** — buy price cap, `marketAtBuy` snapshot, stock adjustment audit ([#7](https://github.com/bhuber15/PokeDB1/pull/7)) — *migration `0011_money-guardrails`*
- **Rapid stock intake** — stay-in-flow add form ([#8](https://github.com/bhuber15/PokeDB1/pull/8))
- **Shop operations** — cash up, buy slips, batch QR labels, sales by staff ([#9](https://github.com/bhuber15/PokeDB1/pull/9))
- **Card search fixes** — freeze, result cap, fuzzy matching ([#10](https://github.com/bhuber15/PokeDB1/pull/10))
- **Wants folded into Customers**, Wants nav tab removed ([#11](https://github.com/bhuber15/PokeDB1/pull/11))
- Catalogue browser (direct to main): browse by set and by Pokémon name, shared `CatalogueBrowser`, series/era capture — *migration `0012`*; nav tabs renamed/reordered by till-workflow frequency

## 2026-07-05 — launch-prep wave

- **Business ops** — money hardening, pence conversion, refunds, reports; `reset-shop-data` script, mock seeds dropped ([#1](https://github.com/bhuber15/PokeDB1/pull/1))
- **Launch prep** — nightly price-sync cron on Vercel + Sentry error tracking ([#2](https://github.com/bhuber15/PokeDB1/pull/2))
- **Offline sale queue with idempotent checkout** (Package D) ([#3](https://github.com/bhuber15/PokeDB1/pull/3)) — *migration `0009_sale-client-uuid`*
- **Front-end polish** — lint hygiene, `next/image`, empty states, a11y, POS ergonomics ([#4](https://github.com/bhuber15/PokeDB1/pull/4))
- **Till UX** — cash tender & change, receipts, cart steppers, VAT-aware checkout ([#5](https://github.com/bhuber15/PokeDB1/pull/5))

## 2026-07-02 → 07-04 — architectural risk fixes (Packages A–C, direct to main)

- **Package A: money-core hardening** — `DomainError` + `guarded()` route wrapper, domain layer extracted and tested (`createSale`/`createRefund`/`createBuy`), server-canonical sale pricing (client sends quantities + `expectedTotal` only), cumulative refund cap, `cost_at_sale` snapshot — *migration `0006_cost-at-sale`*
- **Package B: integer pence + VAT groundwork** — all money columns to integer pence, `vatScheme` setting applied in `createSale` — *migration `0007_pence-migration`*
- **Package C: full card catalogue + resilient price sync** — *migration `0008_catalogue-price-history`*
- zod validation for all JSON API bodies; first Playwright e2e (login → POS → cash sale); GitHub Actions CI (lint, test, build)

## 2026-07-01 — buylist, customers, store credit, refunds, reports, CSV

Direct to main, one intense day:

- Buylist (cash or store credit), customers UI with credit ledger, store-credit payments at POS, want lists with in-stock detection
- Refunds end to end: tables, endpoint with restock + VAT reversal + store credit, dialog in Reports — *migration `0005`*
- Reports: date-range summary with gross margin, date-range picker
- CSV: dependency-free encode/parse, sales export, inventory export/import with per-row validation
- Cardmarket EUR prices via TCGdex: price columns, source picker, nightly backfill cron — *migration `0004`*

## 2026-06-29 → 06-30 — Phase 1 MVP

- Scaffold: Next.js + Turso + Drizzle + shadcn/ui; Phase 1 schema — *migrations `0000`–`0003` over this period*
- Owner password auth (iron-session) + staff PIN system with PinPad
- Inventory management with QR labels; Pokémon TCG API integration with price caching
- POS search/cart/checkout with stock decrement; sales reports dashboard
- Shop settings backend + UI overhaul, card zoom, price lookup
