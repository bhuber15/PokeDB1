import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

const patchInventoryBody = z.object({
  quantity: z.number().int().optional(),
  condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
  costPrice: z.number().optional(),
  sellPriceOverride: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  defectNotes: z.string().nullable().optional(),
  lowStockThreshold: z.number().int().nullable().optional(),
})

export const PATCH = guarded(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireStaff(await getSession())

  const { id } = await params
  const body = await parseBody(req, patchInventoryBody)
  const updates = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined)
  )

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const [updated] = await db.update(inventoryItems)
    .set(updates)
    .where(eq(inventoryItems.id, parseInt(id)))
    .returning()

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(updated)
})

export const DELETE = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireAdmin(await getSession())
  const { id } = await params
  // Soft delete — preserves historical sale_items that reference this item
  const [updated] = await db.update(inventoryItems)
    .set({ isActive: false })
    .where(eq(inventoryItems.id, parseInt(id)))
    .returning()
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
})
