// lib/db/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
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
  externalId: text('external_id'), // Pokemon TCG API card id e.g. "xy7-54"
  tcgplayerId: text('tcgplayer_id'),
  imageUrl: text('image_url'),
  imageUrlLarge: text('image_url_large'),
})

export const inventoryItems = sqliteTable('inventory_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: integer('card_id').references(() => cards.id),
  condition: text('condition').notNull(), // NM | LP | MP | HP | DMG
  quantity: integer('quantity').notNull().default(0),
  costPrice: real('cost_price').notNull(),
  sellPriceOverride: real('sell_price_override'),
  qrCode: text('qr_code').notNull().unique(),
  location: text('location'),
  defectNotes: text('defect_notes'),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(1),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const priceCache = sqliteTable('price_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: integer('card_id').notNull().references(() => cards.id).unique(),
  tcgplayerMarket: real('tcgplayer_market'),
  tcgplayerLow: real('tcgplayer_low'),
  tcgplayerMid: real('tcgplayer_mid'),
  tcgplayerHigh: real('tcgplayer_high'),
  lastSyncedAt: text('last_synced_at').notNull().default(sql`(datetime('now'))`),
  isHighValue: integer('is_high_value', { mode: 'boolean' }).notNull().default(false),
})

export const sales = sqliteTable('sales', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  staffId: integer('staff_id').references(() => staff.id),
  subtotal: real('subtotal').notNull(),
  discountAmount: real('discount_amount').notNull().default(0),
  vatAmount: real('vat_amount').notNull().default(0),
  vatScheme: text('vat_scheme').notNull().default('none'), // 'standard' | 'margin' | 'none'
  total: real('total').notNull(),
  paymentMethod: text('payment_method').notNull(), // 'cash' | 'card' | 'store_credit' | 'other'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const saleItems = sqliteTable('sale_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  quantity: integer('quantity').notNull(),
  priceAtSale: real('price_at_sale').notNull(),
})

// Single-row shop settings (always id = 1)
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  shopName: text('shop_name').notNull().default('PokeDB'),
  usdToGbp: real('usd_to_gbp').notNull().default(0.79),
  marginMultiplier: real('margin_multiplier').notNull().default(0.85),
  highValueThreshold: real('high_value_threshold').notNull().default(50),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export type Staff = typeof staff.$inferSelect
export type Card = typeof cards.$inferSelect
export type InventoryItem = typeof inventoryItems.$inferSelect
export type PriceCache = typeof priceCache.$inferSelect
export type Sale = typeof sales.$inferSelect
export type SaleItem = typeof saleItems.$inferSelect
export type Settings = typeof settings.$inferSelect
