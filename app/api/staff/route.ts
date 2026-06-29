import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import bcrypt from 'bcryptjs'
import { getSession } from '@/lib/auth'

export async function GET() {
  const session = await getSession()
  if (!session.isOwnerLoggedIn) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const members = await db.select({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    isActive: staff.isActive,
  }).from(staff)
  return NextResponse.json(members)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { name, pin, role } = await req.json()
  if (!name || !pin || !/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: 'name and 4-digit pin required' }, { status: 400 })
  }
  const pinHash = await bcrypt.hash(pin, 10)
  const [member] = await db.insert(staff)
    .values({ name, pinHash, role: role ?? 'staff' })
    .returning({ id: staff.id, name: staff.name, role: staff.role })
  return NextResponse.json(member, { status: 201 })
}
