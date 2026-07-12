# Runbook: deploy a single-tenant beta shop (Wizard-of-Oz)

Deploys one shop on its own Vercel project + Turso DB using the codebase as-is
(`TENANCY_MODE` unset = single-tenant). Target: ~30 minutes per shop.
This is the validation-phase model from the master plan and the standing
fallback if the multi-tenant build slips (cap: ~10 shops).

## 1. Create the database (EU region for UK GDPR)

```bash
turso db create shop-<slug> --location fra
turso db show shop-<slug> --url        # → TURSO_DATABASE_URL
turso db tokens create shop-<slug>     # → TURSO_AUTH_TOKEN
```

## 2. Apply migrations

**Gotcha:** `drizzle-kit` reads `TURSO_*` from your shell, which overrides
`.env.local`. Point the shell vars at the NEW shop DB explicitly:

```bash
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx drizzle-kit migrate
```

## 3. Seed catalogue + staff

```bash
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx tsx scripts/import-catalogue.ts
TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npx tsx scripts/seed-staff.ts
```

Catalogue import takes several minutes (~20K cards; idempotent — safe to re-run).

## 4. Create the Vercel project

New Vercel project from this repo (one per shop), then set env vars
(Production):

| Var | Value |
|---|---|
| `TURSO_DATABASE_URL` | from step 1 |
| `TURSO_AUTH_TOKEN` | from step 1 |
| `SESSION_SECRET` | `openssl rand -base64 32` (unique per shop) |
| `OWNER_PASSWORD_HASH` | bcrypt hash of the shop's owner password (`npx tsx -e "import('bcryptjs').then(async b=>console.log(await b.hash(process.argv[1],10)))" 'THE-PASSWORD'`) |
| `CRON_SECRET` | `openssl rand -hex 24` (unique per shop) |
| `PRICE_USD_TO_GBP` / `PRICE_EUR_TO_GBP` | current rates, e.g. `0.79` / `0.86` |
| `NEXT_PUBLIC_BRAND_NAME` | the (post-rename) brand name |

**Gotcha:** this Next version's env parser expands `$` in values — escape as
`\$` (see `.env.test` for the precedent).

Add the price-sync cron in the Vercel project (Settings → Cron Jobs):
`GET /api/cron/sync-prices`, daily, header `Authorization: Bearer <CRON_SECRET>`.

Assign the domain: `<slug>.<base-domain>` → this project.

## 5. Smoke-check (5 minutes)

- [ ] `https://<slug>.<domain>/api/health` → `{"ok":true,"db":true}`
- [ ] Owner login works; set staff PINs in Settings → Staff
- [ ] Shop name + margins configured in Settings
- [ ] Search a card at the POS, sell it, refund it
- [ ] Buylist: price a card, complete a buy
- [ ] Trigger the cron once manually and confirm prices populate

## 6. Onboarding (from the ops report)

Book the 30-minute Zoom; import their inventory CSV via Inventory → Import;
shop owner processes one real transaction before the call ends.

## Adopting into the platform later

The shop's Turso DB **is** a valid tenant DB. When multi-tenancy ships,
adoption = insert a registry row pointing at this DB (no data migration),
move the subdomain to the platform project, retire the per-shop Vercel project.
