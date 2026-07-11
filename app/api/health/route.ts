import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

// Unauthenticated liveness check for uptime monitoring. Verifies the app is
// serving and its default database answers a trivial query.
export async function GET() {
  try {
    await db.run(sql`select 1`)
    return NextResponse.json({ ok: true, db: true })
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 })
  }
}
