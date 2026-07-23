import { NextRequest, NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireStaff, requireAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { getSettings, updateSettings, type AppSettings } from '@/lib/settings'
import { isLanguage, type Language } from '@/lib/games'

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  return NextResponse.json(await getSettings(db))
})

export const PATCH = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  // Only admins can change shop settings
  requireAdmin(await getSession(await currentTenantId()))

  const body = await req.json()
  const patch: Partial<AppSettings> = {}

  if (typeof body.shopName === 'string' && body.shopName.trim()) {
    patch.shopName = body.shopName.trim().slice(0, 60)
  }
  for (const key of ['usdToGbp', 'eurToGbp', 'marginMultiplier', 'highValueThreshold'] as const) {
    if (body[key] != null) {
      const n = Number(body[key])
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      }
      patch[key] = n
    }
  }
  if (body.primaryPriceSource != null) {
    if (body.primaryPriceSource !== 'cardmarket' && body.primaryPriceSource !== 'tcgplayer') {
      return NextResponse.json({ error: 'Invalid primaryPriceSource' }, { status: 400 })
    }
    patch.primaryPriceSource = body.primaryPriceSource
  }
  if (body.vatScheme != null) {
    if (body.vatScheme !== 'none' && body.vatScheme !== 'standard' && body.vatScheme !== 'margin') {
      return NextResponse.json({ error: 'Invalid vatScheme' }, { status: 400 })
    }
    patch.vatScheme = body.vatScheme
  }
  if (body.marginNoCostHandling != null) {
    if (body.marginNoCostHandling !== 'exclude' && body.marginNoCostHandling !== 'block') {
      return NextResponse.json({ error: 'Invalid marginNoCostHandling' }, { status: 400 })
    }
    patch.marginNoCostHandling = body.marginNoCostHandling
  }
  for (const key of ['buyCashPct', 'buyCreditPct'] as const) {
    if (body[key] != null) {
      const n = Number(body[key])
      if (!Number.isFinite(n) || n <= 0 || n > 1) {
        return NextResponse.json({ error: `Invalid ${key}: must be > 0 and ≤ 1` }, { status: 400 })
      }
      patch[key] = n
    }
  }
  if (body.enabledLanguages != null) {
    if (!Array.isArray(body.enabledLanguages) || !body.enabledLanguages.every(isLanguage)) {
      return NextResponse.json({ error: 'Invalid enabledLanguages' }, { status: 400 })
    }
    // 'EN' is always on — the EN catalogue is the app's baseline.
    patch.enabledLanguages = [...new Set<Language>(['EN', ...body.enabledLanguages])]
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  return NextResponse.json(await updateSettings(patch, db))
})
