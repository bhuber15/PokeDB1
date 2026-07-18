# Runbook: platform ops setup (Phase 3)

Everything in Phase 3 is env-gated with a no-op default: an unset var means
the feature is off and nothing breaks. Set vars on the **platform** Vercel
project (all environments unless noted). Single-tenant (Wizard-of-Oz)
deploys need none of these except, optionally, the backup token and Sentry.

## Environment variables

| Var | Feature | Value |
|---|---|---|
| `PLATFORM_ADMIN_PASSWORD_HASH` | admin dashboard login | bcrypt hash — generate: `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'your-password'` |
| `SENTRY_DSN` | server error reporting | DSN from sentry.io project settings |
| `NEXT_PUBLIC_SENTRY_DSN` | browser error reporting | same DSN value |
| `SENTRY_ENVIRONMENT` | optional | defaults to the Vercel env name |
| `SENTRY_TRACES_SAMPLE_RATE` | optional perf tracing | e.g. `0.1`; default `0` (errors only) |
| `NEXT_PUBLIC_POSTHOG_KEY` | product analytics | PostHog project API key (**EU cloud project** — data residency) |
| `NEXT_PUBLIC_POSTHOG_HOST` | optional | default `https://eu.i.posthog.com` |
| `NEXT_PUBLIC_CRISP_WEBSITE_ID` | support chat widget | Crisp website ID (Settings → Setup instructions) |
| `BLOB_READ_WRITE_TOKEN` | backup cron | create a **private-access** Blob store on the Vercel project; the token is auto-added |
| `BACKUP_RETENTION_DAYS` | optional | default `14` |

Already required since Phases 0–2 (unchanged): `TENANCY_MODE`,
`PLATFORM_BASE_HOST`, `PLATFORM_DATABASE_URL`, `PLATFORM_AUTH_TOKEN`,
`TURSO_GROUP_AUTH_TOKEN`, `TURSO_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`,
`SESSION_SECRET`, `CRON_SECRET`, Stripe + Resend vars
(see stripe-billing-setup.md).

## Registry migration

Phase 3 adds registry migration `0002_impersonation-grants.sql`. Apply to the
live platform DB before (or with) the deploy:

```bash
env -u TURSO_DATABASE_URL -u TURSO_AUTH_TOKEN npx drizzle-kit migrate --config drizzle-platform.config.ts
```

(`PLATFORM_DATABASE_URL`/`PLATFORM_AUTH_TOKEN` must point at the live registry.)

## Crons (vercel.json — already committed)

| Path | Schedule | What |
|---|---|---|
| `/api/cron/sync-prices` | daily 03:00 | single-tenant deploys only; no-ops green (`{skipped}`) in multi |
| `/api/cron/sync-tenants` | every 15 min | multi: price-syncs tenants due (>20h since last), oldest first, 240s budget per invocation |
| `/api/cron/backup-tenants` | hourly at :30 | dumps tenants due (>20h) to Blob; prunes past retention; in single mode backs up the one DB |

Sub-daily schedules need Vercel Pro. All three routes expect
`Authorization: Bearer $CRON_SECRET` — Vercel sends it automatically when the
`CRON_SECRET` env var exists.

A failed tenant inside a cron run does **not** stop the run: the failure is
listed in the response JSON, reported to Sentry, and retried next day (the
cursor still advances so one broken shop can't starve the rest).

## Admin dashboard

- `https://admin.<PLATFORM_BASE_HOST>` → tenant list: billing status, plan,
  signed-up date, last activity + DB reachability (probed live from each
  tenant DB, cached 5 min), Stripe customer link. `/admin/audit` → the
  `platform_audit` trail (provisioning, status changes, impersonation).
- Login is the `PLATFORM_ADMIN_PASSWORD_HASH` password; the session cookie
  (`platform-admin-session`) lives only on the admin host and lasts 12h.
- **Impersonation**: "Open shop" mints a single-use 60-second grant, audited
  at both ends (`impersonate_grant` / `impersonate_login`), and lands you in
  the shop as an owner-level session named **Platform support** (4h cookie).
  It cannot ring sales or buys — staff-attributed writes fail on purpose;
  it's for viewing and fixing configuration. Log out via the shop's normal
  logout when done.
- Locally: browsers resolve `*.localhost` automatically — with
  `TENANCY_MODE=multi` visit `http://admin.localhost:3000`.

## Rate limits (fixed-window, per instance)

| Endpoint | Limit |
|---|---|
| signup | 5 / 10 min / IP (Phase 2) |
| setup token page | 10 / 10 min / IP (Phase 2) |
| owner login | 20 / 10 min / IP |
| staff PIN | 120 / 10 min / IP (the per-shop DB lockout remains the brute-force guard) |
| admin login | 10 / 10 min / IP |
| impersonation consume | 10 / 10 min / IP |

The Stripe webhook is deliberately unlimited: it is signature-verified and
rate-limiting it would drop billing lifecycle events.

## Adopting the Wizard-of-Oz beta shops

Per shop (see also wizard-of-oz-shop-deploy.md, "Adopting into the platform
later"): the shop's Turso DB already is a valid tenant DB —

```bash
PLATFORM_DATABASE_URL=<live registry url> npx tsx scripts/create-tenant.ts \
  --slug <shop> --name "<Shop Name>" \
  --db-url libsql://<their-db-hostname> --skip-migrations
```

Then point `<shop>.<PLATFORM_BASE_HOST>` DNS at the platform deployment and
retire the per-shop Vercel project. The first backup and price sync happen
automatically within a cycle — a missing `tenant_sync_state` row counts as
most-overdue, so adopted shops go to the front of both queues.
