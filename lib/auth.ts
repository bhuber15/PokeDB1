import { getIronSession, IronSession, SessionOptions } from 'iron-session'
import { cookies } from 'next/headers'
import { DomainError } from '@/lib/domain/errors'

export interface SessionData {
  isOwnerLoggedIn: boolean
  staffId?: number
  staffRole?: 'admin' | 'staff'
  staffName?: string
  tenantId?: string
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'shop-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
  },
}

// currentTenantId: pass the resolved tenant on multi-tenant requests so a
// session minted for one shop can never act on another (defence in depth —
// cookies are already host-scoped per subdomain).
export async function getSession(currentTenantId?: string): Promise<IronSession<SessionData>> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
  if (currentTenantId && session.tenantId && session.tenantId !== currentTenantId) {
    session.destroy()
    return getIronSession<SessionData>(await cookies(), sessionOptions)
  }
  return session
}

// Resolve the current tenant id from proxy-injected headers (multi mode only).
export async function currentTenantId(): Promise<string | undefined> {
  if (process.env.TENANCY_MODE !== 'multi') return undefined
  const { headers } = await import('next/headers')
  return (await headers()).get('x-tenant-id') ?? undefined
}

// Billing status of the current tenant, from proxy-injected headers
// (multi mode only) — drives the past-due banner.
export async function currentTenantStatus(): Promise<string | undefined> {
  if (process.env.TENANCY_MODE !== 'multi') return undefined
  const { headers } = await import('next/headers')
  return (await headers()).get('x-tenant-status') ?? undefined
}

// Device unlocked (owner password) — pre-PIN surfaces like the PIN pad's staff list.
export function requireOwner(session: SessionData): SessionData {
  if (!session.isOwnerLoggedIn) throw new DomainError('UNAUTHORIZED', 'Login required')
  return session
}

export function requireStaff(session: SessionData): SessionData & { staffId: number } {
  if (!session.staffId) throw new DomainError('UNAUTHORIZED', 'Staff PIN required')
  return session as SessionData & { staffId: number }
}

// Admin PIN session required. Note: this deliberately tightens the old
// hand-rolled checks, which accepted any device-unlocked session as admin.
export function requireAdmin(session: SessionData): SessionData & { staffId: number } {
  const s = requireStaff(session)
  if (s.staffRole !== 'admin') throw new DomainError('FORBIDDEN', 'Admin only')
  return s
}

// Owner (device unlocked) or admin PIN — billing surfaces are the owner's
// business, reachable before any staff PIN is entered.
export function requireOwnerOrAdmin(session: SessionData): SessionData {
  if (!session.isOwnerLoggedIn && session.staffRole !== 'admin') {
    throw new DomainError('UNAUTHORIZED', 'Login required')
  }
  return session
}
