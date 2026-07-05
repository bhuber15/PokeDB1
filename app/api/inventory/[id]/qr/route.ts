import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateQRDataURL } from '@/lib/qr'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  requireStaff(await getSession())

  const { id } = await params
  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, parseInt(id)))
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const dataUrl = await generateQRDataURL(item.qrCode)
  return NextResponse.json({ dataUrl, qrCode: item.qrCode })
})
