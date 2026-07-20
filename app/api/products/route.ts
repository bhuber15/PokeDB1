import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { createProduct } from '@/lib/domain/products'
import { PRODUCT_CATEGORIES, EAN_RE } from '@/lib/product-categories'

const createProductBody = z.object({
  name: z.string().trim().min(1),
  category: z.enum(PRODUCT_CATEGORIES),
  ean: z.string().regex(EAN_RE, 'Barcode must be 8–14 digits').nullable().optional(),
  sellPrice: z.number().int().positive(), // pence
  costPrice: z.number().int().nonnegative().nullable().optional(), // pence
  quantity: z.number().int().nonnegative(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const body = await parseBody(req, createProductBody)
  const result = await createProduct(body, db)
  return NextResponse.json(result, { status: 201 })
})
