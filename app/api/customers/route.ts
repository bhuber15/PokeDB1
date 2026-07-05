import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { customers } from '@/lib/db/schema'
import { like, desc } from 'drizzle-orm'
import { getSession, requireStaff } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'

const createCustomerBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  phone: z.string().optional(),
  email: z.string().optional(),
  notes: z.string().optional(),
})

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
  const { name, phone, email, notes } = await parseBody(req, createCustomerBody)
  const [c] = await db.insert(customers).values({
    name, phone: phone || null, email: email || null, notes: notes || null,
  }).returning()
  return NextResponse.json(c, { status: 201 })
})
