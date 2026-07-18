import type { SessionOptions } from 'iron-session'

// Split from admin-auth.ts so proxy.ts can read the admin cookie without
// pulling bcryptjs/next-headers into the proxy bundle.

export interface AdminSessionData { isPlatformAdmin?: boolean }

export const adminSessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'platform-admin-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 12,
  },
}
