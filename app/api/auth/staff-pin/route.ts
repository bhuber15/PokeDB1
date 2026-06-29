import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getSession } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { pin } = await req.json()
  if (!pin || !/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: 'Invalid PIN format' }, { status: 400 })
  }
  const activeStaff = await db.select().from(staff).where(eq(staff.isActive, true))
  for (const member of activeStaff) {
    if (await bcrypt.compare(pin, member.pinHash)) {
      const session = await getSession()
      session.staffId = member.id
      session.staffRole = member.role as 'admin' | 'staff'
      session.staffName = member.name
      await session.save()
      return NextResponse.json({ id: member.id, name: member.name, role: member.role })
    }
  }
  return NextResponse.json({ error: 'PIN not recognised' }, { status: 401 })
}

export async function DELETE() {
  const session = await getSession()
  session.staffId = undefined
  session.staffRole = undefined
  session.staffName = undefined
  await session.save()
  return NextResponse.json({ ok: true })
}
