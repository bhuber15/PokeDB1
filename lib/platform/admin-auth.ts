import { getIronSession, IronSession } from 'iron-session'
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { DomainError } from '@/lib/domain/errors'
import { adminSessionOptions, type AdminSessionData } from './admin-session'

// Founders-only platform admin (spec §3.4): env-based password, its own
// cookie on the admin host — completely separate from shop sessions.

export { adminSessionOptions, type AdminSessionData } from './admin-session'

export async function getAdminSession(): Promise<IronSession<AdminSessionData>> {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const hash = process.env.PLATFORM_ADMIN_PASSWORD_HASH
  if (!hash) return false   // fail closed: no env hash → nobody authenticates
  return bcrypt.compare(password, hash)
}

export function requirePlatformAdmin(s: AdminSessionData): void {
  if (!s.isPlatformAdmin) throw new DomainError('UNAUTHORIZED', 'Platform admin login required')
}
