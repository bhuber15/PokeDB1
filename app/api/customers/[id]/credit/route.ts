import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { creditLedger } from '@/lib/db/schema'
import { getSession } from '@/lib/auth'
import { getCustomerBalance } from '@/lib/credit'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }
  const customerId = parseInt((await params).id)
  const { delta, reason } = await req.json()
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return NextResponse.json({ error: 'Invalid delta' }, { status: 400 })
  await db.insert(creditLedger).values({
    customerId, delta: Math.round(n * 100) / 100, reason: 'adjustment',
    staffId: session.staffId ?? null,
  })
  return NextResponse.json({ balance: await getCustomerBalance(customerId) })
}
