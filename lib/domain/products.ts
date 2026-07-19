import { eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { products, inventoryItems, type Product, type InventoryItem } from '@/lib/db/schema'
import { PRODUCT_CATEGORIES, PRODUCT_CONDITION, EAN_RE, type ProductCategory } from '@/lib/product-categories'
import { generateQRId } from '@/lib/qr'
import { DomainError, isUniqueViolation } from './errors'

export interface CreateProductInput {
  name: string
  category: ProductCategory
  ean?: string | null
  sellPrice: number // pence — required: products have no market price to fall back to
  costPrice?: number | null
  quantity: number
  lowStockThreshold?: number
}

export interface UpdateProductInput {
  name?: string
  category?: ProductCategory
  ean?: string | null
}

function validateCommon(input: { name?: string; category?: ProductCategory; ean?: string | null }) {
  if (input.name != null && input.name.trim().length === 0) {
    throw new DomainError('INVALID_INPUT', 'Name is required')
  }
  if (input.category != null && !PRODUCT_CATEGORIES.includes(input.category)) {
    throw new DomainError('INVALID_INPUT', 'Invalid category')
  }
  if (input.ean != null && !EAN_RE.test(input.ean)) {
    throw new DomainError('INVALID_INPUT', 'Barcode must be 8–14 digits')
  }
}

export async function createProduct(
  input: CreateProductInput,
  dbc: Db = db,
): Promise<{ product: Product; item: InventoryItem }> {
  validateCommon(input)
  if (input.name.trim().length === 0) throw new DomainError('INVALID_INPUT', 'Name is required')
  if (!Number.isInteger(input.sellPrice) || input.sellPrice < 1) {
    throw new DomainError('INVALID_INPUT', 'Sell price must be a positive integer (pence)')
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new DomainError('INVALID_INPUT', 'Invalid quantity')
  }

  return dbc.transaction(async (tx) => {
    if (input.ean) {
      const [existing] = await tx
        .select({ product: products, item: inventoryItems })
        .from(products)
        .leftJoin(inventoryItems, eq(inventoryItems.productId, products.id))
        .where(eq(products.ean, input.ean))
        .limit(1)
      if (existing) {
        if (existing.item?.isActive) {
          throw new DomainError('DUPLICATE_EAN', 'A product with this barcode already exists', { productId: existing.product.id })
        }
        // Re-stocking a discontinued line under the same barcode: reuse the
        // identity row, refresh it, and reactivate (or recreate) its stock row.
        const [product] = await tx.update(products)
          .set({ name: input.name.trim(), category: input.category })
          .where(eq(products.id, existing.product.id)).returning()
        const stockValues = {
          quantity: input.quantity,
          costPrice: input.costPrice ?? null,
          sellPriceOverride: input.sellPrice,
          lowStockThreshold: input.lowStockThreshold ?? 1,
          isActive: true,
        }
        const [item] = existing.item
          ? await tx.update(inventoryItems).set(stockValues)
              .where(eq(inventoryItems.id, existing.item.id)).returning()
          : await tx.insert(inventoryItems).values({
              ...stockValues, productId: product.id, condition: PRODUCT_CONDITION, qrCode: generateQRId(),
            }).returning()
        return { product, item }
      }
    }

    const [product] = await tx.insert(products).values({
      name: input.name.trim(),
      category: input.category,
      ean: input.ean ?? null,
    }).returning()
    const [item] = await tx.insert(inventoryItems).values({
      productId: product.id,
      condition: PRODUCT_CONDITION,
      quantity: input.quantity,
      costPrice: input.costPrice ?? null,
      sellPriceOverride: input.sellPrice,
      lowStockThreshold: input.lowStockThreshold ?? 1,
      qrCode: generateQRId(),
    }).returning()
    return { product, item }
  })
}

export async function updateProduct(
  id: number,
  input: UpdateProductInput,
  dbc: Db = db,
): Promise<Product> {
  validateCommon(input)
  try {
    const [updated] = await dbc.update(products).set({
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.category != null ? { category: input.category } : {}),
      ...(input.ean !== undefined ? { ean: input.ean } : {}),
    }).where(eq(products.id, id)).returning()
    if (!updated) throw new DomainError('NOT_FOUND', 'Product not found')
    return updated
  } catch (e) {
    if (isUniqueViolation(e, 'products.ean')) {
      throw new DomainError('DUPLICATE_EAN', 'A product with this barcode already exists')
    }
    throw e
  }
}
