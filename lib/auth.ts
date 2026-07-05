import { getIronSession, IronSession, SessionOptions } from 'iron-session'
import { cookies } from 'next/headers'
import { DomainError } from '@/lib/domain/errors'

export interface SessionData {
  isOwnerLoggedIn: boolean
  staffId?: number
  staffRole?: 'admin' | 'staff'
  staffName?: string
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'pokedb-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
  },
}

export async function getSession(): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(await cookies(), sessionOptions)
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
