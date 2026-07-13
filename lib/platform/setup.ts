import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { DomainError } from '@/lib/domain/errors'
import type { Db } from '@/lib/db'
import { setOwnerPasswordHash, createStaff } from '@/lib/domain/staff'
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
  await setOwnerPasswordHash(await bcrypt.hash(input.password, 10), tenantDb)
  const member = await createStaff({ name: input.staffName, pin: input.pin, role: 'admin' }, tenantDb)
  const now = Math.floor(Date.now() / 1000)
  await pdb.update(tenants)
    .set({ setupToken: null, setupCompletedAt: now, updatedAt: now })
    .where(eq(tenants.id, t.id))
  await pdb.insert(platformAudit).values({ actor: 'system', tenantId: t.id, action: 'setup_completed' })
  return { staffId: member.id, staffName: member.name }
}

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
