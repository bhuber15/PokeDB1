import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { updateProduct } from '@/lib/domain/products'
import { PRODUCT_CATEGORIES, EAN_RE } from '@/lib/product-categories'

const patchProductBody = z.object({
  name: z.string().trim().min(1).optional(),
  category: z.enum(PRODUCT_CATEGORIES).optional(),
  ean: z.string().regex(EAN_RE, 'Barcode must be 8–14 digits').nullable().optional(),
})

export const PATCH = guarded(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const id = parseIdParam((await params).id)
  const body = await parseBody(req, patchProductBody)
  return NextResponse.json(await updateProduct(id, body, db))
})
