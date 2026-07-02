import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'

const PATCHABLE_FIELDS = new Set([
  'quantity', 'condition', 'costPrice', 'sellPriceOverride',
  'location', 'defectNotes', 'lowStockThreshold',
])

export const PATCH = guarded(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireStaff(await getSession())

  const { id } = await params
  const body = await req.json()
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => PATCHABLE_FIELDS.has(k))
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
