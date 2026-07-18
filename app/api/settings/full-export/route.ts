import { NextResponse } from 'next/server'
import { getTenantDb } from '@/lib/db'
import { getSession, requireOwnerOrAdmin, currentTenantId } from '@/lib/auth'
import { guarded } from '@/lib/api'
import { buildFullExport } from '@/lib/export-all'

export const maxDuration = 120   // 20K-card catalogues take a few seconds to serialise

export const GET = guarded(async () => {
  const db = await getTenantDb()
  requireOwnerOrAdmin(await getSession(await currentTenantId()))
  const { zip } = await buildFullExport(db)
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="shop-data-${date}.zip"`,
    },
  })
})
