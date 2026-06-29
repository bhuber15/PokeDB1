import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inventoryItems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { generateQRDataURL } from '@/lib/qr'
import { getSession } from '@/lib/auth'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession()
  if (!session.isOwnerLoggedIn) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, parseInt(id)))
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const dataUrl = await generateQRDataURL(item.qrCode)
  return NextResponse.json({ dataUrl, qrCode: item.qrCode })
}
