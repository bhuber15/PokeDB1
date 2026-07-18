import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/auth'
import { parseTenantSlug, getTenantBySlug } from '@/lib/platform/tenants'
import { decideTenantRouting, decideAdminRouting, isAdminHost } from '@/lib/platform/routing'
import { adminSessionOptions, type AdminSessionData } from '@/lib/platform/admin-session'

const PUBLIC_PATHS = ['/login', '/pin', '/api/auth/owner', '/api/auth/staff-pin', '/api/auth/impersonate', '/api/cron/', '/api/health', '/suspended', '/signup', '/api/platform/', '/setup', '/api/setup']

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Never trust inbound tenant headers — the proxy is their only writer.
  const requestHeaders = new Headers(req.headers)
  for (const h of ['x-tenant-id', 'x-tenant-db-url', 'x-tenant-status', 'x-tenant-plan', 'x-tenant-entitlements']) requestHeaders.delete(h)

  let resolvedTenantId: string | undefined

  if (process.env.TENANCY_MODE === 'multi') {
    const baseHost = process.env.PLATFORM_BASE_HOST
    if (!baseHost) return new NextResponse('Platform misconfigured', { status: 500 })

    // Founders' dashboard host: its own cookie, its own routing table.
    if (isAdminHost(req.headers.get('host') ?? '', baseHost)) {
      const res = NextResponse.next({ request: { headers: requestHeaders } })
      const adminSession = await getIronSession<AdminSessionData>(req, res, adminSessionOptions)
      const decision = decideAdminRouting(pathname, adminSession.isPlatformAdmin === true)
      switch (decision.kind) {
        case 'pass': return res
        case 'redirect-login': return NextResponse.redirect(new URL('/admin/login', req.url))
        case 'rewrite': return NextResponse.rewrite(new URL(decision.path, req.url), { request: { headers: requestHeaders } })
        case 'not-found': return new NextResponse('Not found', { status: 404 })
      }
    }
    // The dashboard exists only on the admin host.
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return new NextResponse('Not found', { status: 404 })
    }

    const slug = parseTenantSlug(req.headers.get('host') ?? '', baseHost)
    const tenant = slug ? await getTenantBySlug(slug) : null
    const decision = decideTenantRouting({ slug, tenant })

    if (decision.kind === 'not-tenant') {
      // Apex/www/admin: marketing site is external; admin arrives in Phase 3.
      // The platform surface (signup, Stripe webhook, health) lives here.
      const platformPaths = ['/signup', '/api/platform/', '/api/health']
      if (platformPaths.some(p => pathname.startsWith(p))) {
        return NextResponse.next({ request: { headers: requestHeaders } })
      }
      return new NextResponse('Not found', { status: 404 })
    }
    if (decision.kind === 'unknown') return new NextResponse('Unknown shop', { status: 404 })
    if (decision.kind === 'blocked') {
      if (pathname.startsWith('/suspended') || pathname.startsWith('/api/health')) {
        return NextResponse.next({ request: { headers: requestHeaders } })
      }
      // API calls from a still-open till get a machine-readable answer,
      // not a rewritten HTML lock screen.
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'This shop is currently unavailable', code: 'SHOP_UNAVAILABLE' },
          { status: 403 },
        )
      }
      return NextResponse.rewrite(new URL(`/suspended?reason=${decision.status}`, req.url))
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
