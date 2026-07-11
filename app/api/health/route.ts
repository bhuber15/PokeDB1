import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, isMultiTenant } from '@/lib/db'
import { getPlatformDb } from '@/lib/platform/db'

// Unauthenticated liveness check. Single mode pings the shop DB; multi mode
// pings the registry (tenant DBs are checked per-tenant by the backup cron).
export async function GET() {
  try {
    if (isMultiTenant()) {
      await getPlatformDb().run(sql`select 1`)
    } else {
      await db.run(sql`select 1`)
    }
    return NextResponse.json({ ok: true, db: true })
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 })
  }
}
