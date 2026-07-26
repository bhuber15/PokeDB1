# PokeDB

Point-of-sale and inventory platform for UK trading-card shops. Runs a single shop out of the box, or an entire multi-tenant SaaS platform behind a flag.

Sell singles and sealed product at the till, buy cards from customers, track stock by condition, sync market prices nightly, manage store credit, and report on everything — across **Pokémon**, **Magic: The Gathering**, and **Yu-Gi-Oh!** (each shop enables the games it trades in).

> Docs map: this file (setup + overview) · [AGENTS.md](AGENTS.md) (architecture + domain rules — the canonical dev reference) · [treeview.md](treeview.md) (annotated repo tree) · [CHANGELOG.md](CHANGELOG.md) (what shipped, when) · [docs/runbooks/](docs/runbooks/) (operational guides) · [docs/superpowers/](docs/superpowers/) (feature plans and design specs)

## Features

**Till (POS)**
- Search-as-you-type card lookup (fuzzy, scanner-safe) plus sealed products, gated by each shop's enabled games
- Server-canonical pricing: market price × margin, per-item overrides, and a per-condition price ladder — the client only ever sends quantities and an `expectedTotal` for the server to verify
- Cash (with tender/change), card, store credit, and split-tender payments; discounts; offline sale queue with idempotent replay when the connection drops
- Printed and emailed receipts; on-demand price refresh with an honest price-age badge; optional customer link on every sale

**Buylist**
- Buy from customers for cash or store credit, at a % of market with a price cap and a `marketAtBuy` snapshot
- Printable buy slips; on-demand Cardmarket refresh so EUR prices are fresh at the counter

**Inventory & catalogue**
- One row per card + condition, rapid stay-in-flow intake, CSV import/export, QR labels (single and batch sheets)
- Sealed products, accessories and snacks as non-card SKUs
- Full card catalogue for all three games (pokemontcg.io / TCGdex, Scryfall, YGOPRODeck), browseable by set or Pokémon name, including Japanese/Korean/Chinese Pokémon singles
- Stock adjustments carry an audited reason; a wants list surfaces "in stock now" matches with a nav badge

**Money & compliance**
- All money is integer pence, end to end; VAT standard or **margin scheme** (second-hand goods) applied server-side
- Refunds (partial or full, capped at the amount charged, with restock and VAT reversal) and same-day voids as a distinct flow
- Append-only store-credit ledger; cost/margin data is admin-only

**Reports**
- Daily dashboard, date-range summaries with gross margin, cash-up close records, stock valuation, dead stock, reorder list, sales by staff, and CSV exports; margin-scheme stock book for HMRC

**Staff & auth**
- Owner password login plus per-staff PIN pads (bcrypt), `admin`/`staff` roles, DB-backed login lockouts

**Platform mode (optional)**
- `TENANCY_MODE=multi` turns on the SaaS layer: subdomain-per-shop routing, tenant registry, self-serve signup, Stripe billing with plan entitlements, automated Turso provisioning, an ops dashboard on `admin.<base>` with audited single-use impersonation, staggered price-sync and hourly backup crons, and a full-shop zip export

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript
- [Turso](https://turso.tech) (SQLite/libSQL) with [Drizzle ORM](https://orm.drizzle.team)
- Tailwind CSS v4, shadcn/Base UI components
- iron-session auth, zod validation, Stripe billing, Playwright + node test runner

## Getting started (single shop)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` with the core variables:

   ```bash
   TURSO_DATABASE_URL=      # libsql:// URL, or file:local.db for a local SQLite file
   TURSO_AUTH_TOKEN=        # not needed for local file DBs
   SESSION_SECRET=          # 32+ char random string
   OWNER_PASSWORD_HASH=     # bcrypt hash of the owner password
   POKEMON_TCG_API_KEY=     # pokemontcg.io key, for price syncing
   CRON_SECRET=             # protects the /api/cron/* endpoints
   PRICE_USD_TO_GBP=        # exchange rates applied to market prices
   PRICE_EUR_TO_GBP=
   ```

3. Apply the schema and seed a first staff member:

   ```bash
   npx drizzle-kit migrate
   npx tsx scripts/seed-staff.ts   # creates "Admin" with PIN 1234 — change it in Settings → Staff
   ```

4. Import the card catalogue (idempotent; the first Pokémon run takes a while):

   ```bash
   npx tsx scripts/import-catalogue.ts                    # every enabled game
   npx tsx scripts/import-catalogue.ts --only=mtg,yugioh  # just-enabled games, skip Pokémon
   ```

5. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) — owner logs in at `/`, staff at `/pin`. Magic and Yu-Gi-Oh! are off by default; turn them on per shop in **Settings → Games**, then import their catalogues.

### Optional environment variables

| Group | Variables |
|---|---|
| Email receipts | `RESEND_API_KEY`, `EMAIL_FROM` |
| Branding | `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_BRAND_SUPPORT_EMAIL` |
| Pricing defaults | `MARGIN_MULTIPLIER`, `HIGH_VALUE_THRESHOLD` (fallback defaults for Settings; threshold in pounds) |
| Observability | `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (all no-ops when unset) |
| Platform mode | `TENANCY_MODE=multi`, `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN`, `PLATFORM_BASE_HOST`, `PLATFORM_ADMIN_PASSWORD_HASH` |
| Tenant provisioning | `TURSO_ORG`, `TURSO_GROUP`, `TURSO_API_TOKEN`, `TURSO_GROUP_AUTH_TOKEN` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` |
| Backups | `BLOB_READ_WRITE_TOKEN`, `BACKUP_RETENTION_DAYS` |

Platform setup end to end is documented in [docs/runbooks/platform-ops-setup.md](docs/runbooks/platform-ops-setup.md) and [docs/runbooks/stripe-billing-setup.md](docs/runbooks/stripe-billing-setup.md).

## Scripts

Run with `npx tsx scripts/<name>.ts`:

| Script | What it does |
|---|---|
| `import-catalogue.ts` | Full catalogue import for every enabled game (same idempotent sweep as the nightly cron); `--only=mtg,yugioh` limits the run |
| `seed-staff.ts` | Seed an admin staff member (PIN 1234) |
| `sync-cardmarket.ts` | One-off Cardmarket (EUR) price backfill |
| `backfill-series.ts` | Backfill series/era on existing catalogue rows |
| `generate-pokedex-aliases.ts` | Regenerate the Pokédex name-alias data used by fuzzy search |
| `dedupe-inventory.ts` | Merge duplicate inventory rows (card + condition) |
| `reset-shop-data.ts` | Wipe transactional data + catalogue — **previews by default**, pass `--yes` to execute |
| `create-tenant.ts` | Create a tenant in the platform registry (local/dev) |
| `restore-backup.ts` | Restore a tenant DB from a platform backup |

## Development

```bash
npm test          # unit tests — node test runner via tsx, in-memory libSQL, real migrations
npm run test:e2e  # Playwright checkout smoke tests (seeds a throwaway DB, headless Chromium)
npm run lint      # eslint
npm run build     # production build
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, unit tests, and build on every push.

Two e2e env gotchas, documented in [AGENTS.md](AGENTS.md): this Next version lets `.env.local` override real process env (inverted from the docs), and the env parser expands `$` in values — escape as `\$` in `.env.test`.

### Architecture in one minute

- `lib/domain/` holds the business logic with colocated `*.test.ts`; API routes in `app/api/` stay thin, wrap handlers in `guarded()` and validate bodies with zod via `parseBody()`
- Domain functions take an optional `Db` handle (tests pass in-memory; multi-tenant routes pass the tenant DB from `getTenantDb()`) and throw `DomainError(code, message)` for expected failures
- Market prices are cached in `price_cache` and refreshed by `/api/cron/sync-prices`
- Client components must never value-import anything that touches `lib/db` — see the client-bundle boundary rule in [AGENTS.md](AGENTS.md)

The full set of domain rules (integer pence, server-canonical pricing, VAT, refund caps, credit ledger) lives in [AGENTS.md](AGENTS.md) — read it before changing money paths. The repo layout is mapped in [treeview.md](treeview.md).

### Migrations

After editing `lib/db/schema.ts`, generate with `npx drizzle-kit generate`; the platform registry has its own config (`npx drizzle-kit generate --config drizzle-platform.config.ts`). **Deploys do not auto-migrate** — run `npx drizzle-kit migrate` against the target DB yourself (unset any shell `TURSO_*` vars first so `.env.local` wins), and the dev server will warn on boot if the DB is behind the checked-in migrations.

## Deployment

Designed for [Vercel](https://vercel.com) with Turso. Set the environment variables above in the Vercel project; [vercel.json](vercel.json) schedules the crons (nightly price sync at 03:00, plus 15-minute tenant sync and hourly backups in platform mode), all authenticated with `CRON_SECRET`.

- Single-shop deploy: [docs/runbooks/wizard-of-oz-shop-deploy.md](docs/runbooks/wizard-of-oz-shop-deploy.md)
- Platform ops (admin dashboard, backups, observability): [docs/runbooks/platform-ops-setup.md](docs/runbooks/platform-ops-setup.md)
- Backup/restore drill: [docs/runbooks/backup-restore-drill.md](docs/runbooks/backup-restore-drill.md)
