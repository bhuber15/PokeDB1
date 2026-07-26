# Repo tree

Annotated map of the tracked repo (~440 files). Tests are colocated: assume `foo.ts` has a `foo.test.ts` next to it — they are omitted below unless the test *is* the point. Regenerate the raw listing with `git ls-files`.

Local-only things you may see in the working directory but which are **not part of this repo**: `Research/` and `cardtill-site/` (separate private repos), `local-sandbox.db` (throwaway MTG/YGO sandbox), `tenant-dbs/`, `.env.local*`, `.next/`, `node_modules/`.

```
.
├── AGENTS.md                    # canonical dev reference: stack, architecture, domain rules
├── CLAUDE.md                    # -> @AGENTS.md
├── README.md                    # setup + feature overview
├── CHANGELOG.md                 # what shipped, when (newest first)
├── treeview.md                  # this file
├── proxy.ts                     # request entry: session auth + tenant resolution (subdomain -> x-tenant-* headers)
├── next.config.ts               # image hosts, Sentry wrapper
├── instrumentation.ts           # Sentry server init (env-gated no-op)
├── instrumentation-client.ts    # Sentry/PostHog client init (env-gated no-op)
├── vercel.json                  # crons: sync-prices 03:00 daily; sync-tenants */15; backup-tenants hourly
├── drizzle.config.ts            # tenant-schema migrations  -> lib/db/migrations/
├── drizzle-platform.config.ts   # platform-registry migrations -> lib/platform/migrations/
├── playwright.config.ts         # e2e: NODE_ENV=test + .env.test, seeds throwaway DB
├── components.json              # shadcn config
├── eslint.config.mjs / postcss.config.mjs / tsconfig.json
├── .env.test                    # e2e env ($ must be escaped as \$ — see AGENTS.md)
├── .github/workflows/ci.yml    # lint + unit tests + build
│
├── app/
│   ├── layout.tsx / page.tsx    # root layout; owner login landing
│   ├── globals.css / icon.svg / not-found.tsx
│   ├── login/  pin/             # owner password login; staff PIN pad
│   ├── setup/  signup/          # first-run shop setup; platform self-serve signup (+ done/)
│   ├── suspended/               # billing-suspended tenant interstitial
│   ├── admin/                   # platform ops dashboard (admin.<base>)
│   │   ├── login/               #   PLATFORM_ADMIN_PASSWORD_HASH login
│   │   └── (protected)/         #   tenant overview + audit/ (impersonation log)
│   ├── (app)/                   # the shop app (session-guarded)
│   │   ├── pos/                 #   till: search, cart, checkout, receipts, sale queue
│   │   ├── buylist/             #   buy from customers (cash / store credit)
│   │   ├── inventory/           #   stock table + add/ (rapid intake: cards & products)
│   │   ├── catalogue/           #   browse full catalogue by set / name
│   │   ├── customers/           #   list + [id]/ detail (credit, wants, purchase history)
│   │   ├── prices/              #   market-price lookup
│   │   ├── reports/             #   dashboards, cash-up, refunds/voids, exports
│   │   └── settings/            #   shop settings, games, staff, billing, data export
│   └── api/                     # route handlers: thin guarded() + parseBody() wrappers over lib/domain
│       ├── auth/                #   owner, staff-pin, impersonate (platform admin -> shop session)
│       ├── billing/             #   Stripe checkout + portal/
│       ├── buys/                #   create/list buys, [id], export (CSV)
│       ├── cards/               #   search, names, sets, browse, browse-by-name, [id]
│       ├── cron/                #   sync-prices, sync-tenants, backup-tenants (CRON_SECRET)
│       ├── customers/           #   CRUD + [id]/credit (ledger adjustments)
│       ├── inventory/           #   CRUD, [id]/qr, import (CSV), export
│       ├── labels/batch/        #   batch QR label sheets
│       ├── onboarding/          #   first-run checklist state
│       ├── platform/            #   signup, stripe webhooks, admin login/impersonate, jobs/seed-catalogue
│       ├── prices/              #   search, cardmarket (on-demand EUR refresh)
│       ├── products/            #   non-card SKUs CRUD
│       ├── refunds/             #   create refund (capped, restocking, VAT-aware)
│       ├── reports/             #   sales (+export), inventory, cash-up, margin-stock-book
│       ├── sales/               #   create sale; history, search, [id]/{items,receipt,void}
│       ├── settings/            #   get/update + full-export (whole-shop zip)
│       ├── setup/  staff/  wants/  health/
│
├── lib/
│   ├── api.ts                   # guarded() route wrapper: auth, DomainError -> HTTP mapping
│   ├── auth.ts                  # iron-session config, requireOwner/requireStaff/requireAdmin
│   ├── validation.ts            # parseBody() — zod validation for JSON bodies
│   ├── settings.ts              # shop settings incl. VAT scheme, margins, condition ladder
│   ├── games.ts                 # game registry + per-tenant enablement (settings.enabledGames)
│   ├── pricing.ts               # market price -> sell price (margin, overrides, conditions, GBP conversion)
│   ├── fuzzy.ts / pokedex.ts    # fuzzy card search + Pokédex name aliases (lib/data/pokedex-en.json)
│   ├── csv.ts                   # dependency-free CSV encode/parse
│   ├── email.ts / receipt-html.ts  # Resend sender; receipt rendering
│   ├── sale-queue.ts            # offline sale queue (client-side, idempotent replay)
│   ├── pos-stock.ts             # live stock counts after sales
│   ├── credit.ts                # store-credit balance helpers
│   ├── trading-day.ts           # Europe/London trading day (BST-safe same-day checks)
│   ├── plan.ts / entitlements.ts   # billing plans + feature gating
│   ├── brand.ts                 # NEXT_PUBLIC_BRAND_* white-labelling
│   ├── observability.ts         # Sentry/PostHog helpers (no-op unless configured)
│   ├── export-all.ts            # full-shop zip export
│   ├── adjustment-reasons.ts / product-categories.ts  # dependency-free shared constants (client-safe)
│   ├── qr.ts / utils.ts / wants-grouping.ts
│   ├── apis/                    # external API clients: pokemon-tcg, tcgdex, scryfall, ygoprodeck
│   ├── db/
│   │   ├── schema.ts            # tenant schema (cards, inventory, products, sales, buys, credit, staff…)
│   │   ├── index.ts             # db singleton + getTenantDb(); the singleton throws in multi mode
│   │   ├── migrate.ts / migration-drift.ts  # programmatic migrate; dev-boot drift warning
│   │   ├── dump.ts / test-helpers.ts
│   │   └── migrations/          # numbered drizzle-kit SQL migrations + meta/ journal
│   ├── domain/                  # business logic; optional Db param; throws DomainError
│   │   ├── sales.ts             #   createSale: server-canonical pricing, VAT, split tender, replay
│   │   ├── refunds.ts / voids.ts    # refund caps + restock; same-day void
│   │   ├── sale-claim.ts        #   atomic in-transaction claim so void/refund can't double-reverse
│   │   ├── buys.ts              #   buylist transactions (cash / store credit)
│   │   ├── customers.ts         #   purchase history (voided sales excluded)
│   │   ├── inventory.ts / products.ts
│   │   ├── catalogue.ts / card-search.ts / sales-search.ts
│   │   ├── cash-ups.ts / reports.ts / receipts.ts
│   │   ├── staff.ts / wants.ts / onboarding.ts / auth-lockout.ts
│   │   └── errors.ts            #   DomainError(code, message)
│   ├── platform/                # multi-tenant SaaS layer (TENANCY_MODE=multi)
│   │   ├── schema.ts / db.ts    #   registry schema + client (PLATFORM_DATABASE_URL)
│   │   ├── routing.ts / tenants.ts  # subdomain -> tenant resolution
│   │   ├── signup.ts / provision.ts / setup.ts / turso.ts  # self-serve signup -> idempotent Turso provisioning
│   │   ├── billing.ts / stripe.ts / emails.ts  # Stripe lifecycle (idempotent via stripe_events)
│   │   ├── admin-auth.ts / admin-session.ts / impersonation.ts  # ops dashboard + audited single-use impersonation
│   │   ├── fanout.ts / rate-limit.ts  # cursor-staggered tenant crons; limiter
│   │   ├── backup.ts / backup-store.ts / overview.ts
│   │   └── migrations/          #   registry migrations (separate journal)
│   ├── prices/                  # price sync engine: sync.ts, run-sync.ts, tcgdex-sweep.ts
│   └── sources/                 # catalogue import: registry, upsert, external-id,
│                                #   scryfall-bulk/-sweep, ygoprodeck-sweep, types
│
├── components/                  # feature-organised React components (client-safe imports only)
│   ├── pos/                     # SearchBar, CardResult, ProductResult, Cart, CheckoutDialog,
│   │                            #   ReceiptDialog, SaleQueue
│   ├── inventory/               # AddItemForm, AddProductForm, ImportDialog, InventoryTable, QRLabel
│   ├── buylist/                 # BuyCard, BuyCart, BuySlipDialog
│   ├── customers/               # CustomerDetail, WantsPanel
│   ├── reports/                 # CashUpSection, DateRangePicker, RefundDialog, StockSection, VoidSaleDialog
│   ├── settings/                # SettingsForm, StaffSection, BillingCard, DataExportCard
│   ├── catalogue/               # CatalogueBrowser (shared by Catalogue tab + Buy page)
│   ├── auth/ staff/             # LoginForm; PinPad
│   ├── admin/                   # AdminLoginForm, AdminNav, ImpersonateButton
│   ├── platform/ onboarding/    # SignupForm, SetupForm; OnboardingChecklist
│   ├── layout/                  # Nav
│   ├── shared/                  # CustomerPicker, CardZoomModal, GameBadge/GameFilter (+ sticky hook),
│   │                            #   SessionProvider, SettingsProvider, BillingBanner, CrispChat, printLabelSheet
│   └── ui/                      # shadcn primitives: badge, button, card, dialog, input, label,
│                                #   separator, skeleton, sonner, table
│
├── scripts/                     # npx tsx scripts/<name>.ts  (see README for the full table)
│   ├── import-catalogue.ts      # full catalogue sweep, --only=<games>
│   ├── seed-staff.ts / sync-cardmarket.ts / backfill-series.ts / generate-pokedex-aliases.ts
│   ├── dedupe-inventory.ts / reset-shop-data.ts (preview by default)
│   ├── create-tenant.ts / restore-backup.ts
│   └── load-env.ts              # shared .env.local loader for scripts
│
├── tests/
│   ├── dom-setup.ts             # jsdom bootstrap for component tests
│   ├── tenancy-guard.test.ts    # enforces: routes must use getTenantDb(), never the db singleton
│   └── e2e/                     # Playwright: checkout, multi-game-checkout, intake, csv-import,
│                                #   wants, search-enter, cjk-quickset (+ env.ts, seed.ts)
│
└── docs/
    ├── market-research-2026-06.md
    ├── runbooks/                # wizard-of-oz-shop-deploy, stripe-billing-setup,
    │                            #   platform-ops-setup, backup-restore-drill
    ├── testing/                 # dated smoke-test logs
    └── superpowers/             # feature plans (plans/, ~20 dated) + design specs (specs/, ~10 dated)
```
