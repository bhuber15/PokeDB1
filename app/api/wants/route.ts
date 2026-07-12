import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTenantDb } from '@/lib/db'
import { wantList } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession, requireStaff, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { parseBody, parseIdParam } from '@/lib/validation'
import { listOpenWants, setWantNotify } from '@/lib/domain/wants'

const createWantBody = z.object({
  customerId: z.number().int(),
  cardId: z.number().int().nullable().optional(),
  freeText: z.string().nullable().optional(),
}).refine(b => b.cardId != null || b.freeText?.trim(), 'Either cardId or freeText is required')

const patchWantBody = z.object({ notify: z.boolean() })

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))
  const wants = await listOpenWants(db)
  return NextResponse.json({ wants })
})

export const POST = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const { customerId, cardId, freeText } = await parseBody(req, createWantBody)

  const [item] = await db.insert(wantList).values({
    customerId,
    cardId: cardId ?? null,
    freeText: freeText?.trim() ?? null,
  }).returning()

  return NextResponse.json(item, { status: 201 })
})

export const PATCH = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const id = parseIdParam(req.nextUrl.searchParams.get('id'))
  const { notify } = await parseBody(req, patchWantBody)
  await setWantNotify(id, notify, db)

  return NextResponse.json({ ok: true })
})

export const DELETE = guarded(async (req: NextRequest) => {
  const db = await getTenantDb()
  requireStaff(await getSession(await currentTenantId()))

  const id = parseIdParam(req.nextUrl.searchParams.get('id'))

  await db
    .update(wantList)
    .set({ fulfilledAt: new Date().toISOString() })
    .where(eq(wantList.id, id))

  return NextResponse.json({ ok: true })
})
