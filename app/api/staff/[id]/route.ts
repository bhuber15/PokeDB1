import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession, requireAdmin } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { updateStaff } from '@/lib/domain/staff'

const patchStaffBody = z.object({
  name: z.string().trim().min(1).optional(),
  role: z.enum(['admin', 'staff']).optional(),
  isActive: z.boolean().optional(),
  pin: z.string().regex(/^\d{4}$/, '4-digit pin required').optional(),
})

export const PATCH = guarded(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  requireAdmin(await getSession())
  const id = parseIdParam((await params).id)
  const patch = await parseBody(req, patchStaffBody)
  const updated = await updateStaff(id, patch)
  return NextResponse.json(updated)
})
