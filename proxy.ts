import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/auth'
import { parseTenantSlug, getTenantBySlug } from '@/lib/platform/tenants'
import { decideTenantRouting } from '@/lib/platform/routing'

const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/cron/', '/api/health', '/suspended']

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Never trust inbound tenant headers — the proxy is their only writer.
  const requestHeaders = new Headers(req.headers)
  for (const h of ['x-tenant-id', 'x-tenant-db-url', 'x-tenant-status']) requestHeaders.delete(h)

  let resolvedTenantId: string | undefined

  if (process.env.TENANCY_MODE === 'multi') {
    const baseHost = process.env.PLATFORM_BASE_HOST
    if (!baseHost) return new NextResponse('Platform misconfigured', { status: 500 })
    const slug = parseTenantSlug(req.headers.get('host') ?? '', baseHost)
    const tenant = slug ? await getTenantBySlug(slug) : null
    const decision = decideTenantRouting({ slug, tenant })

    if (decision.kind === 'not-tenant') {
      // Apex/www/admin: no shop app here yet (marketing site is external;
      // admin arrives in Phase 3). Health stays reachable for monitors.
      if (pathname.startsWith('/api/health')) return NextResponse.next({ request: { headers: requestHeaders } })
      return new NextResponse('Not found', { status: 404 })
    }
    if (decision.kind === 'unknown') return new NextResponse('Unknown shop', { status: 404 })
    if (decision.kind === 'blocked') {
      if (pathname.startsWith('/suspended') || pathname.startsWith('/api/health')) {
        return NextResponse.next({ request: { headers: requestHeaders } })
      }
      return NextResponse.rewrite(new URL('/suspended', req.url))
    }
    for (const [k, v] of Object.entries(decision.headers)) requestHeaders.set(k, v)
    resolvedTenantId = decision.headers['x-tenant-id']
  }

  const pass = () => NextResponse.next({ request: { headers: requestHeaders } })

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return pass()

  const res = pass()
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  const crossTenant =
    resolvedTenantId !== undefined && session.tenantId !== undefined && session.tenantId !== resolvedTenantId
  if (!session.isOwnerLoggedIn || crossTenant) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
