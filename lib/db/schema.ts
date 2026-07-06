// lib/db/schema.ts
import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const staff = sqliteTable('staff', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  pinHash: text('pin_hash').notNull(),
  role: text('role').notNull().default('staff'), // 'admin' | 'staff'
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
})

export const cards = sqliteTable('cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  game: text('game').notNull().default('pokemon'),
  setName: text('set_name').notNull(),
  setNumber: text('set_number').notNull(),
  variant: text('variant'),
  language: text('language').notNull().default('EN'),
  externalId: text('external_id').unique(), // Pokemon TCG API card id e.g. "xy7-54"
  tcgplayerId: text('tcgplayer_id'),
  imageUrl: text('image_url'),
  imageUrlLarge: text('image_url_large'),
})

export const inventoryItems = sqliteTable('inventory_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: integer('card_id').references(() => cards.id),
  condition: text('condition').notNull(), // NM | LP | MP | HP | DMG
  quantity: integer('quantity').notNull().default(0),
  costPrice: integer('cost_price').notNull(),
  sellPriceOverride: integer('sell_price_override'),
  qrCode: text('qr_code').notNull().unique(),
  location: text('location'),
  defectNotes: text('defect_notes'),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(1),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// Daily price snapshots (pence). Only recorded for in-stock or high-value
// cards; pruned after 90 days by the sync cron.
export const priceHistory = sqliteTable('price_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: integer('card_id').notNull().references(() => cards.id),
  cardmarketTrend: integer('cardmarket_trend'),
  tcgplayerMarket: integer('tcgplayer_market'),
  recordedOn: text('recorded_on').notNull(), // YYYY-MM-DD
}, t => [unique().on(t.cardId, t.recordedOn)])

export const priceCache = sqliteTable('price_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: integer('card_id').notNull().references(() => cards.id).unique(),
  tcgplayerMarket: integer('tcgplayer_market'),
  tcgplayerLow: integer('tcgplayer_low'),
  tcgplayerMid: integer('tcgplayer_mid'),
  tcgplayerHigh: integer('tcgplayer_high'),
  cardmarketTrend: integer('cardmarket_trend'),
  cardmarketLow: integer('cardmarket_low'),
  cardmarketAvg: integer('cardmarket_avg'),
  cardmarketSyncedAt: text('cardmarket_synced_at'),
  lastSyncedAt: text('last_synced_at').notNull().default(sql`(datetime('now'))`),
  isHighValue: integer('is_high_value', { mode: 'boolean' }).notNull().default(false),
})

export const sales = sqliteTable('sales', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Idempotency key from the POS client; replaying a queued offline sale
  // with the same uuid returns the original sale instead of double-charging
  clientUuid: text('client_uuid').unique(),
  staffId: integer('staff_id').references(() => staff.id),
  subtotal: integer('subtotal').notNull(),
  discountAmount: integer('discount_amount').notNull().default(0),
  vatAmount: integer('vat_amount').notNull().default(0),
  vatScheme: text('vat_scheme').notNull().default('none'), // 'standard' | 'margin' | 'none'
  total: integer('total').notNull(),
  paymentMethod: text('payment_method').notNull(), // 'cash' | 'card' | 'store_credit' | 'other'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const saleItems = sqliteTable('sale_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  quantity: integer('quantity').notNull(),
  priceAtSale: integer('price_at_sale').notNull(),
  costAtSale: integer('cost_at_sale'), // cost_price snapshot; VAT-margin groundwork
})

export const refunds = sqliteTable('refunds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  staffId: integer('staff_id').references(() => staff.id),
  method: text('method').notNull(), // 'cash' | 'store_credit'
  amount: integer('amount').notNull(), // total refunded, GBP, includes reversed VAT
  reason: text('reason'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const refundItems = sqliteTable('refund_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refundId: integer('refund_id').notNull().references(() => refunds.id),
  saleItemId: integer('sale_item_id').notNull().references(() => saleItems.id),
  quantity: integer('quantity').notNull(),
})

// Single-row shop settings (always id = 1)
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  shopName: text('shop_name').notNull().default('PokeDB'),
  usdToGbp: real('usd_to_gbp').notNull().default(0.79),
  marginMultiplier: real('margin_multiplier').notNull().default(0.85),
  highValueThreshold: integer('high_value_threshold').notNull().default(5000), // pence
  eurToGbp: real('eur_to_gbp').notNull().default(0.86),
  primaryPriceSource: text('primary_price_source').notNull().default('cardmarket'),
  buyCashPct: real('buy_cash_pct').notNull().default(0.5),
  buyCreditPct: real('buy_credit_pct').notNull().default(0.65),
  vatScheme: text('vat_scheme').notNull().default('none'), // 'none' | 'standard'
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const customers = sqliteTable('customers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const creditLedger = sqliteTable('credit_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  delta: integer('delta').notNull(), // +credit issued, -credit spent
  reason: text('reason').notNull(), // 'buylist' | 'sale' | 'adjustment' | 'refund'
  refType: text('ref_type'), // 'buy' | 'sale' | null
  refId: integer('ref_id'),
  staffId: integer('staff_id').references(() => staff.id),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const buyTransactions = sqliteTable('buy_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  staffId: integer('staff_id').references(() => staff.id),
  customerId: integer('customer_id').references(() => customers.id),
  method: text('method').notNull(), // 'cash' | 'store_credit'
  total: integer('total').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const buyItems = sqliteTable('buy_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  buyId: integer('buy_id').notNull().references(() => buyTransactions.id),
  cardId: integer('card_id').references(() => cards.id),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  condition: text('condition').notNull(),
  quantity: integer('quantity').notNull(),
  payPrice: integer('pay_price').notNull(), // per-item GBP paid
})

// Endpoint-scoped login throttling. DB-backed because serverless instances
// share no memory. One row per scope ('staff-pin' | 'owner'); timestamps are
// unix epoch seconds so lockout arithmetic stays integer-only.
export const authLockouts = sqliteTable('auth_lockouts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull().unique(),
  failCount: integer('fail_count').notNull().default(0),
  windowStart: integer('window_start').notNull(),
  lockedUntil: integer('locked_until'),
})

export const wantList = sqliteTable('want_list', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  cardId: integer('card_id').references(() => cards.id),
  freeText: text('free_text'), // when the card isn't in our DB yet
  notify: integer('notify', { mode: 'boolean' }).notNull().default(true),
  fulfilledAt: text('fulfilled_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export type Staff = typeof staff.$inferSelect
export type Card = typeof cards.$inferSelect
export type InventoryItem = typeof inventoryItems.$inferSelect
export type PriceCache = typeof priceCache.$inferSelect
export type Sale = typeof sales.$inferSelect
export type SaleItem = typeof saleItems.$inferSelect
export type Settings = typeof settings.$inferSelect
export type Customer = typeof customers.$inferSelect
export type CreditLedger = typeof creditLedger.$inferSelect
export type BuyTransaction = typeof buyTransactions.$inferSelect
export type BuyItem = typeof buyItems.$inferSelect
export type WantListItem = typeof wantList.$inferSelect
export type AuthLockout = typeof authLockouts.$inferSelect
export type Refund = typeof refunds.$inferSelect
export type RefundItem = typeof refundItems.$inferSelect
