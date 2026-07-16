import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { listStaff, createStaff, assertStaffSeatAvailable } from '@/lib/domain/staff'
import { getEntitlements } from '@/lib/entitlements'

const createStaffBody = z.object({
  name: z.string().trim().min(1, 'name is required'),
  pin: z.string().regex(/^\d{4}$/, '4-digit pin required'),
  role: z.enum(['admin', 'staff']).default('staff'),
})

// Readable by the device owner (pre-PIN) or any admin (Settings → Staff).
export const GET = guarded(async () => {
  const db = await getTenantDb()
  const session = await getSession(await currentTenantId())
  if (!session.isOwnerLoggedIn && session.staffRole !== 'admin') {
    throw new DomainError('UNAUTHORIZED', 'Login required')
  }
  return NextResponse.json(await listStaff(db))
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  await assertStaffSeatAvailable(await getEntitlements(), db)
  const { name, pin, role } = await parseBody(req, createStaffBody)
  const member = await createStaff({ name, pin, role }, db)
  return NextResponse.json(member, { status: 201 })
})
