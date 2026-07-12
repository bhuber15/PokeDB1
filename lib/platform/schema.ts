import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Platform registry: commercial facts about tenants. Shop data never lives
// here; this DB is never touched by shop-facing domain code.

export const tenants = sqliteTable('tenants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull(),                    // subdomain, e.g. "brads-cards"
  name: text('name').notNull(),                    // shop display name
  status: text('status').notNull().default('trialing'),
  // 'trialing' | 'active' | 'past_due' | 'paused' | 'suspended' | 'cancelled'
  plan: text('plan').notNull().default('growth'),  // 'starter' | 'growth' | 'pro'
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  email: text('email'),                            // owner email (welcome, dunning)
  tursoDbName: text('turso_db_name'),              // null for local file: DBs
  dbUrl: text('db_url').notNull(),                 // libsql://… or file:… (dev)
  region: text('region').notNull().default('fra'), // EU residency for UK GDPR
  setupToken: text('setup_token'),
  setupCompletedAt: integer('setup_completed_at'), // epoch seconds
  entitlementOverrides: text('entitlement_overrides'), // JSON, founding-shop deals
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('tenants_slug_unique').on(t.slug)])

export const stripeEvents = sqliteTable('stripe_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  stripeEventId: text('stripe_event_id').notNull(),
  type: text('type').notNull(),
  processedAt: integer('processed_at').notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('stripe_events_event_id_unique').on(t.stripeEventId)])

export const tenantSyncState = sqliteTable('tenant_sync_state', {
  tenantId: integer('tenant_id').primaryKey().references(() => tenants.id),
  lastPriceSyncAt: integer('last_price_sync_at'),
  lastCatalogueSyncAt: integer('last_catalogue_sync_at'),
  lastBackupAt: integer('last_backup_at'),
})

export const platformAudit = sqliteTable('platform_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),          // 'platform_admin' | 'system' | 'stripe'
  tenantId: integer('tenant_id'),
  action: text('action').notNull(),        // e.g. 'impersonate', 'provision', 'suspend'
  detail: text('detail'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export type Tenant = typeof tenants.$inferSelect
