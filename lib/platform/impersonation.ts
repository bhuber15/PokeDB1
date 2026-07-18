import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getPlatformDb, type PlatformDb } from './db'
import { impersonationGrants, platformAudit, tenants, type Tenant } from './schema'
import { tenantUrl } from './tenants'

// "Open shop as owner" (spec §3.4): the admin dashboard mints a single-use
// 60s grant; the shop host burns it and mints the tenant session. Only the
// sha256 of the token ever touches the registry, and both ends write to
// platform_audit.

export const GRANT_TTL_S = 60

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function createImpersonationGrant(
  tenantId: number,
  opts: { pdb?: PlatformDb; baseHost?: string; nowS?: number } = {},
): Promise<{ url: string } | null> {
  const pdb = opts.pdb ?? getPlatformDb()
  const baseHost = opts.baseHost ?? process.env.PLATFORM_BASE_HOST
  if (!baseHost) throw new Error('PLATFORM_BASE_HOST is not set')
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000)

  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!tenant) return null

  const token = randomBytes(32).toString('hex')
  await pdb.insert(impersonationGrants)
    .values({ tokenHash: sha256(token), tenantId, expiresAt: nowS + GRANT_TTL_S })
  await pdb.insert(platformAudit)
    .values({ actor: 'platform_admin', tenantId, action: 'impersonate_grant', detail: tenant.slug })
  return { url: tenantUrl(tenant.slug, baseHost, `/api/auth/impersonate?token=${token}`) }
}

export async function consumeImpersonationGrant(
  token: string,
  opts: { pdb?: PlatformDb; nowS?: number } = {},
): Promise<Tenant | null> {
  const pdb = opts.pdb ?? getPlatformDb()
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000)

  // Atomic single-use: the UPDATE only matches an unused, unexpired row, so
  // two racing consumes can't both win.
  const claimed = await pdb.update(impersonationGrants)
    .set({ usedAt: nowS })
    .where(and(
      eq(impersonationGrants.tokenHash, sha256(token)),
      isNull(impersonationGrants.usedAt),
      gt(impersonationGrants.expiresAt, nowS),
    ))
    .returning()
  if (claimed.length === 0) return null

  const [tenant] = await pdb.select().from(tenants).where(eq(tenants.id, claimed[0].tenantId)).limit(1)
  if (!tenant) return null
  await pdb.insert(platformAudit)
    .values({ actor: 'platform_admin', tenantId: tenant.id, action: 'impersonate_login', detail: tenant.slug })
  return tenant
}
