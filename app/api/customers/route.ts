import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/db/schema'
import { like, desc } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'

export const GET = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const rows = q
    ? await db.select().from(customers).where(like(customers.name, `%${q}%`)).limit(20)
    : await db.select().from(customers).orderBy(desc(customers.createdAt)).limit(50)
  return NextResponse.json(rows)
})

export const POST = guarded(async (req: NextRequest) => {
  requireStaff(await getSession())
  const { name, phone, email, notes } = await req.json()
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }
  const [c] = await db.insert(customers).values({
    name: name.trim(), phone: phone || null, email: email || null, notes: notes || null,
  }).returning()
  return NextResponse.json(c, { status: 201 })
})
