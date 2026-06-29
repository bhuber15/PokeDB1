import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/api/auth/owner']

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()
  const res = NextResponse.next()
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  if (!session.isOwnerLoggedIn) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
