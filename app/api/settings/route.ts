import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getSettings, updateSettings, type AppSettings } from '@/lib/settings'

export async function GET() {
  const session = await getSession()
  if (!session.staffId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSettings())
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  // Only the owner / admins can change shop settings
  if (session.staffRole !== 'admin' && !session.isOwnerLoggedIn) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const body = await req.json()
  const patch: Partial<AppSettings> = {}

  if (typeof body.shopName === 'string' && body.shopName.trim()) {
    patch.shopName = body.shopName.trim().slice(0, 60)
  }
  for (const key of ['usdToGbp', 'marginMultiplier', 'highValueThreshold'] as const) {
    if (body[key] != null) {
      const n = Number(body[key])
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      }
      patch[key] = n
    }
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

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  return NextResponse.json(await updateSettings(patch))
}
