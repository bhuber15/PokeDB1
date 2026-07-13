import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { getSession, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { updateStaff, assertStaffSeatAvailable } from '@/lib/domain/staff'
import { getEntitlements } from '@/lib/entitlements'

const patchStaffBody = z.object({
  name: z.string().trim().min(1).optional(),
  role: z.enum(['admin', 'staff']).optional(),
  isActive: z.boolean().optional(),
  pin: z.string().regex(/^\d{4}$/, '4-digit pin required').optional(),
})

export const PATCH = guarded(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const db = await getTenantDb()
  requireAdmin(await getSession(await currentTenantId()))
  const id = parseIdParam((await params).id)
  const patch = await parseBody(req, patchStaffBody)
  if (patch.isActive === true) await assertStaffSeatAvailable(await getEntitlements(), db)
  const updated = await updateStaff(id, patch, db)
  return NextResponse.json(updated)
})
