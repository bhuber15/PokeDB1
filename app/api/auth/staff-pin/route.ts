import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getSession } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

const pinLoginBody = z.object({ pin: z.string().regex(/^\d{4}$/, 'Invalid PIN format') })

export const POST = guarded(async (req: NextRequest) => {
  const { pin } = await parseBody(req, pinLoginBody)
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
})

export async function DELETE() {
  const session = await getSession()
  session.staffId = undefined
  session.staffRole = undefined
  session.staffName = undefined
  await session.save()
  return NextResponse.json({ ok: true })
}
