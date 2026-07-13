import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import { DomainError } from '@/lib/domain/errors'
import type { Db } from '@/lib/db'
import { setOwnerPasswordHash, createStaff, type StaffSummary } from '@/lib/domain/staff'
import { getPlatformDb, type PlatformDb } from './db'
import { tenants, platformAudit } from './schema'

// The welcome email's one-time setup link (spec §3.4): the owner sets the
// shop password and their admin PIN in one step, then lands in the app.

export interface SetupInput {
  tenantId: number
  token: string
  password: string
  staffName: string
  pin: string
}

export async function completeSetup(
  input: SetupInput,
  tenantDb: Db,
  pdb: PlatformDb = getPlatformDb(),
): Promise<{ staffId: number; staffName: string }> {
  const [t] = await pdb.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1)
  if (!t || !t.setupToken || t.setupCompletedAt) {
    throw new DomainError('FORBIDDEN', 'This setup link has already been used — log in instead')
  }
  if (!tokensMatch(input.token, t.setupToken)) {
    throw new DomainError('FORBIDDEN', 'This setup link is not valid')
  }
  // Burn first, as an atomic claim: the WHERE re-checks the stored token, so
  // of two concurrent requests exactly one UPDATE matches a row — the loser
  // sees 0 rows and gets the same FORBIDDEN a reused link does.
  const now = Math.floor(Date.now() / 1000)
  const claimed = await pdb.update(tenants)
    .set({ setupToken: null, setupCompletedAt: now, updatedAt: now })
    .where(and(eq(tenants.id, t.id), eq(tenants.setupToken, t.setupToken)))
    .returning({ id: tenants.id })
  if (claimed.length === 0) {
    throw new DomainError('FORBIDDEN', 'This setup link has already been used — log in instead')
  }

  let member: StaffSummary
  try {
    await setOwnerPasswordHash(await bcrypt.hash(input.password, 10), tenantDb)
    member = await createStaff({ name: input.staffName, pin: input.pin, role: 'admin' }, tenantDb)
  } catch (err) {
    // The tenant-DB writes failed after the claim: restore the token so the
    // owner's emailed link still works on retry. Residual risk, accepted: a
    // crash between the claim and this restore (or a failed restore) leaves a
    // dead link — support re-issues a token via the registry in that case.
    try {
      await pdb.update(tenants)
        .set({ setupToken: t.setupToken, setupCompletedAt: null, updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(tenants.id, t.id))
    } catch (restoreErr) {
      console.error(`[setup] failed to restore setup token for tenant ${t.id} — manual re-issue needed:`, restoreErr)
    }
    throw err
  }

  try {
    await pdb.insert(platformAudit).values({ actor: 'system', tenantId: t.id, action: 'setup_completed' })
  } catch (err) {
    // Setup has succeeded — an audit-log hiccup must never surface as an
    // error to the owner.
    console.error(`[setup] failed to record setup_completed audit for tenant ${t.id}:`, err)
  }
  return { staffId: member.id, staffName: member.name }
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
