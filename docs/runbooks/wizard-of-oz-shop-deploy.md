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

### Multi-language (CJK) Pokémon — migration 0021+

- Migration 0021 (`alias_name`, `enabled_languages`, game/language index) must be applied
  to the shop DB **before** deploying this code (additive-only — old code runs fine against
  the new schema, so migrate first, deploy second). Backfill check after migrating:
  `SELECT count(*) FROM cards WHERE game != 'pokemon' OR language != 'EN';` → expected 0
  before the first CJK import; existing external ids are untouched either way.
- To enable CJK Pokémon for a shop: Settings → Card languages, then run
  `npx tsx scripts/import-catalogue.ts` once (add `--full-prices` to backfill alias names
  and the few internationally-listed prices immediately; otherwise they trickle in at
  ~2,000 cards/night via the rotation). Most CJK cards have **no market price** — staff
  set prices at intake or via the till quick-set.

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
| `RESEND_API_KEY` (optional) | Resend key for email receipts (`lib/email.ts`); unset = sending is a logged no-op |
| `EMAIL_FROM` (optional) | verified sender, e.g. `Shop Name <receipts@shop.co.uk>`; default is Resend's onboarding address |
| `NEXT_PUBLIC_BRAND_SUPPORT_EMAIL` (optional) | support address shown on branded pages/emails (default `support@example.com`) |
| `BLOB_READ_WRITE_TOKEN` (optional) | create a **private** Blob store on the project (token auto-added); enables the hourly backup cron, which dumps this DB to `backups/single-tenant/` (see platform-ops-setup.md + backup-restore-drill.md) |
| `BACKUP_RETENTION_DAYS` (optional) | backup retention, default `14` |

**Gotcha:** this Next version's env parser expands `$` in values — escape as
`\$` (see `.env.test` for the precedent).

Crons deploy automatically from `vercel.json` — nothing to add in Vercel
settings: daily `sync-prices`, plus sub-daily `sync-tenants` (no-ops
`{skipped}` on single-tenant) and `backup-tenants` (backs up the DB when the
Blob token is set). The sub-daily schedules need Vercel Pro. Vercel attaches
`Authorization: Bearer <CRON_SECRET>` automatically once that env var exists.

Assign the domain: `<slug>.<base-domain>` → this project.

## 5. Smoke-check (5 minutes)

- [ ] `https://<slug>.<domain>/api/health` → `{"ok":true,"db":true}`
- [ ] Owner login works; set staff PINs in Settings → Staff
- [ ] Shop name + margins configured in Settings
- [ ] Search a card at the POS, sell it, refund it
- [ ] Buylist: price a card, complete a buy
- [ ] Trigger `sync-prices` once manually and confirm prices populate

## 6. Onboarding (from the ops report)

Book the 30-minute Zoom; import their inventory CSV via Inventory → Import;
shop owner processes one real transaction before the call ends.

## Adopting into the platform later

The shop's Turso DB **is** a valid tenant DB. When multi-tenancy ships,
adoption = insert a registry row pointing at this DB (no data migration),
move the subdomain to the platform project, retire the per-shop Vercel project.
