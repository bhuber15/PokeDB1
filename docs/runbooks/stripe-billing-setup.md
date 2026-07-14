# Stripe Billing + provisioning — setup & test runbook

## One-time Stripe dashboard setup (test mode first, then live)

1. **Products/prices**: create three products — Starter, Growth, Pro — each with one
   recurring monthly GBP price (£39 / £79 / £149). Set tax behaviour to *exclusive* and
   enable **Stripe Tax** (UK VAT 20% is added on top; register the VAT number in
   Settings → Tax). Copy the three price ids into env (below).
2. **Customer portal** (Settings → Billing → Customer portal): enable payment-method
   update, invoice history, cancellation (at period end), and plan switches between the
   three prices. Set the business name/branding.
3. **Emails** (Settings → Emails): turn on Stripe's "send emails about expiring cards"
   and failed-payment receipts — they complement our dunning email.
4. **Webhook endpoint** (Developers → Webhooks): endpoint
   `https://www.<PLATFORM_BASE_HOST>/api/platform/stripe`, events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.trial_will_end`,
   `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. **Smart retries** (Settings → Billing → Revenue recovery): keep defaults (retries for
   ~1 week, then cancel the subscription — that cancellation is what suspends the shop).

## Environment variables (platform deployment only)

| Var | Value |
|---|---|
| `TENANCY_MODE` | `multi` |
| `PLATFORM_BASE_HOST` | e.g. `example-brand.co.uk` (no scheme, no port) |
| `PLATFORM_DATABASE_URL` / `PLATFORM_AUTH_TOKEN` | registry DB |
| `TURSO_GROUP_AUTH_TOKEN` | group token for tenant DBs |
| `TURSO_API_TOKEN` / `TURSO_ORG` / `TURSO_GROUP` | platform API for DB creation (group in `fra`); unset TOKEN = local file DBs (dev) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | from the dashboard |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_PRO` | the three price ids |
| `RESEND_API_KEY` / `EMAIL_FROM` | e.g. `Brand <hello@example-brand.co.uk>`; unset = emails logged to console |
| `CRON_SECRET` | also authorises the internal seed-catalogue job |
| `SESSION_SECRET` | shared session key |
| `NEXT_PUBLIC_BRAND_BASE_HOST` | cosmetic subdomain suffix on the signup form |

## Local end-to-end walkthrough (no cloud credentials needed)

```bash
# Terminal 1 — the platform, file-backed registry + tenant DBs:
TENANCY_MODE=multi PLATFORM_BASE_HOST=localhost \
PLATFORM_DATABASE_URL=file:./platform-dev.db \
STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_…(from stripe listen) \
STRIPE_PRICE_STARTER=price_… STRIPE_PRICE_GROWTH=price_… STRIPE_PRICE_PRO=price_… \
CRON_SECRET=dev-secret npm run dev

# Terminal 2 — forward webhooks:
stripe listen --forward-to localhost:3000/api/platform/stripe
```

1. Visit `http://localhost:3000/signup`, pick Growth, submit → Stripe Checkout
   (test mode, no card fields — trial). Complete it.
2. Watch the dev server log: webhook → provision → `[email skipped]` welcome email with
   the setup link. Open the link (`http://<slug>.localhost:3000/setup?token=…`).
3. Set password + PIN → you land in the app with the onboarding checklist. The catalogue
   seed job runs in the background (or run it by hand:
   `curl -X POST -H "Authorization: Bearer dev-secret" -H "content-type: application/json" -d '{"tenantId":1}' http://localhost:3000/api/platform/jobs/seed-catalogue`).
4. Add an inventory item, ring up a sale. **That's the Phase 2 exit test's first half.**

## Lifecycle exit test (Stripe test clocks)

Checkout can't attach customers to test clocks, so drive the lifecycle with a
clock-created subscription wired to the tenant by hand:

```bash
stripe test_clocks create --frozen-time $(date +%s)          # note tc_…
stripe customers create --test-clock tc_… --email brad@example.com   # note cus_…
stripe subscriptions create --customer cus_… \
  -d "items[0][price]"=$STRIPE_PRICE_GROWTH \
  -d trial_period_days=14 \
  -d "trial_settings[end_behavior][missing_payment_method]"=pause    # note sub_…
# Point the provisioned tenant at this pair:
sqlite3 platform-dev.db "UPDATE tenants SET stripe_customer_id='cus_…', stripe_subscription_id='sub_…' WHERE slug='<slug>';"
```

Then advance the clock and check after each step (`stripe test_clocks advance tc_… --to <epoch>`):

- [ ] **+11 days** → `customer.subscription.trial_will_end` → trial-ending email logged.
- [ ] **+14 days, no card** → subscription pauses → tenant `status=paused` → shop shows the
      lock screen. (Resume by attaching test card `4242…` via the portal, advance again → active.)
- [ ] **Failing payment**: attach test card `4000 0000 0000 0341` to the customer as the
      default, resume/advance past trial → `invoice.payment_failed` → dunning email logged,
      tenant `past_due`, shop shows the red banner with "Update card".
- [ ] **Let Smart Retries exhaust** (keep advancing) → `customer.subscription.deleted` →
      tenant `suspended` + suspension email → lock screen.
- [ ] `stripe trigger checkout.session.completed` (fixture without our metadata) →
      webhook answers `ignored:not-signup`; redeliver a processed event from the dashboard →
      `duplicate`.

## Notes

- Provisioning failures: the webhook 500s, the `stripe_events` claim is released and
  Stripe retries with backoff (up to ~3 days). `provisionTenant` is idempotent by slug, so
  retries resume. If retries exhaust, re-send the event from the Stripe dashboard once the
  cause is fixed; `platform_audit` rows carry the trail.
- A tenant whose catalogue seed died mid-run is completed by the nightly
  `/api/cron/sync-prices` sweep — no action needed.
- Wizard-of-Oz shops: unchanged (single-tenant runbook still applies); adopt into the
  platform later via `scripts/create-tenant.ts --skip-migrations` + setting their plan and
  Stripe ids as above.
