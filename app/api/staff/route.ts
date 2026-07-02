import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import bcrypt from 'bcryptjs'
import { getSession, requireOwner, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

const createStaffBody = z.object({
  name: z.string().trim().min(1, 'name is required'),
  pin: z.string().regex(/^\d{4}$/, '4-digit pin required'),
  role: z.enum(['admin', 'staff']).default('staff'),
})

export const GET = guarded(async () => {
  requireOwner(await getSession())
  const members = await db.select({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    isActive: staff.isActive,
  }).from(staff)
  return NextResponse.json(members)
})

export const POST = guarded(async (req: NextRequest) => {
  requireAdmin(await getSession())
  const { name, pin, role } = await parseBody(req, createStaffBody)
  const pinHash = await bcrypt.hash(pin, 10)
  const [member] = await db.insert(staff)
    .values({ name, pinHash, role })
    .returning({ id: staff.id, name: staff.name, role: staff.role })
  return NextResponse.json(member, { status: 201 })
})
