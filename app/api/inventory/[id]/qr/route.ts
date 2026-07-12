import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateQRDataURL } from '@/lib/qr'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseIdParam } from '@/lib/validation'

export const GET = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const id = parseIdParam((await params).id)
  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, id))
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const dataUrl = await generateQRDataURL(item.qrCode)
  return NextResponse.json({ dataUrl, qrCode: item.qrCode })
})
