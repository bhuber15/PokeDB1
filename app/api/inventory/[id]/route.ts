import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { applyInventoryPatch, ADJUSTMENT_REASONS } from '@/lib/domain/inventory'

const patchInventoryBody = z.object({
  quantity: z.number().int().nonnegative().optional(),
  reason: z.enum(ADJUSTMENT_REASONS).optional(), // required when quantity changes
  condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
  costPrice: z.number().int().nonnegative().optional(), // pence
  sellPriceOverride: z.number().int().nonnegative().nullable().optional(), // pence
  location: z.string().nullable().optional(),
  defectNotes: z.string().nullable().optional(),
  lowStockThreshold: z.number().int().nullable().optional(),
})

export const PATCH = guarded(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = requireStaff(await getSession())

  const id = parseIdParam((await params).id)
  const { reason, ...patch } = await parseBody(req, patchInventoryBody)
  const updated = await applyInventoryPatch(id, session.staffId, patch, reason)
  return NextResponse.json(updated)
})

export const DELETE = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireAdmin(await getSession())
  const id = parseIdParam((await params).id)
  // Soft delete — preserves historical sale_items that reference this item
  const [updated] = await db.update(inventoryItems)
    .set({ isActive: false })
    .where(eq(inventoryItems.id, id))
    .returning()
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
})
