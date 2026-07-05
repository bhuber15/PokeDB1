# PokeDB

Point-of-sale and inventory management for a UK Pokémon card shop. Built with Next.js.

## Features

- **POS** — sell singles and sealed product with server-side pricing (market price × margin, or per-item overrides), discounts, and cash/card/store-credit payments
- **Inventory** — track stock by card, condition, and quantity; import via CSV
- **Buylist** — buy cards from customers, with buy pricing and transaction records
- **Prices** — market prices synced from the Pokémon TCG API and TCGdex, converted to GBP and cached; scheduled refresh via a cron endpoint
- **Customers & store credit** — customer records with an append-only credit ledger
- **Refunds** — full or partial, capped at the amount charged
- **Reports** — sales reporting for the shop owner
- **Staff accounts** — owner password login plus per-staff PIN login, with admin/staff roles

## Tech stack

- [Next.js](https://nextjs.org) (App Router), React 19, TypeScript
- [Turso](https://turso.tech) (SQLite) with [Drizzle ORM](https://orm.drizzle.team)
- Tailwind CSS v4, shadcn/Base UI components
- iron-session for auth

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` with at least:

   ```bash
   TURSO_DATABASE_URL=      # libsql URL, or a local file: URL
   TURSO_AUTH_TOKEN=        # not needed for local file DBs
   SESSION_SECRET=          # 32+ char random string
   OWNER_PASSWORD_HASH=     # bcrypt hash of the owner password
   POKEMON_TCG_API_KEY=     # for price syncing
   CRON_SECRET=             # protects the price-sync cron endpoint
   PRICE_USD_TO_GBP=        # exchange rates for market prices
   PRICE_EUR_TO_GBP=
   ```

3. Apply the database schema and seed data:

   ```bash
   npx drizzle-kit migrate
   npx tsx scripts/seed-staff.ts
   npx tsx scripts/seed-cards.ts
   ```

4. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Development

```bash
npm test        # unit tests (node test runner, in-memory SQLite)
npm run lint    # eslint
npm run build   # production build
```

Business logic lives in `lib/domain/` with colocated tests; API routes in `app/api/` are thin wrappers around it. All money is stored as **integer pence** — see [AGENTS.md](AGENTS.md) for the full set of domain rules and conventions.

## Deployment

Designed for [Vercel](https://vercel.com) with a Turso database. Set the environment variables above in the Vercel project, and schedule `GET /api/cron/sync-prices` (with the `CRON_SECRET`) to keep prices fresh.
