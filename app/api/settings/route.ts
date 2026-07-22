import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getSettings, updateSettings, settingsPatchSchema } from '@/lib/settings'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getSettings(db))
})

export const PATCH = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  // Only admins can change shop settings
  requireAdmin(await getSession(await currentTenantId()))
  const patch = await parseBody(req, settingsPatchSchema)
  return NextResponse.json(await updateSettings(patch, db))
})
