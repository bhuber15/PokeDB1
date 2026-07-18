import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { guarded } from '@/lib/api'
import { parseBody } from '@/lib/validation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession, requirePlatformAdmin } from '@/lib/platform/admin-auth'
import { createImpersonationGrant } from '@/lib/platform/impersonation'

const impersonateBody = z.object({ tenantId: z.number().int().positive() })

export const POST = guarded(async (req: NextRequest) => {
  if (!isMultiTenant()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  requirePlatformAdmin(await getAdminSession())
  const { tenantId } = await parseBody(req, impersonateBody)
  const grant = await createImpersonationGrant(tenantId)
  if (!grant) return NextResponse.json({ error: 'Unknown tenant' }, { status: 404 })
  return NextResponse.json(grant)
})
