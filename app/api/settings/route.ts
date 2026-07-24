import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { getSettings, updateSettings, settingsPatchSchema } from '@/lib/settings'
import { getEntitlements } from '@/lib/entitlements'
import { gamesAllowed } from '@/lib/plan'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getSettings(db))
})

export const PATCH = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  // Only admins can change shop settings
  requireAdmin(await getSession(await currentTenantId()))
  // enabledLanguages validation (incl. the EN-always-on guarantee) lives in
  // settingsPatchSchema alongside the other fields.
  const patch = await parseBody(req, settingsPatchSchema)
  if (patch.enabledGames && !gamesAllowed(await getEntitlements(), patch.enabledGames)) {
    return NextResponse.json({ error: 'Multiple games require the Growth plan' }, { status: 403 })
  }
  return NextResponse.json(await updateSettings(patch, db))
})
