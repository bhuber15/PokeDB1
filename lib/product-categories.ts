// Shared between the products domain logic (server) and the product forms /
// POS display (client) — keep this module dependency-free so it never drags
// the DB client into a browser bundle (see lib/adjustment-reasons.ts).
export const PRODUCT_CATEGORIES = ['sealed', 'accessories', 'snacks', 'other'] as const
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  sealed: 'Sealed',
  accessories: 'Accessories',
  snacks: 'Snacks & drinks',
  other: 'Other',
}

// Sentinel stored in inventory_items.condition for product stock rows — the
// column is NOT NULL and card-shaped; products have no condition.
export const PRODUCT_CONDITION = 'NA'

// Manufacturer barcode (EAN-8 through GTIN-14). Digits only.
export const EAN_RE = /^\d{8,14}$/
