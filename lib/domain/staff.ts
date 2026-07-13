import { eq, and, ne } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db, type Db } from '@/lib/db'
import { staff, settings } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import type { Entitlements } from '@/lib/plan'
import { DomainError } from './errors'

export type StaffRole = 'admin' | 'staff'

export interface StaffSummary {
  id: number
  name: string
  role: StaffRole
  isActive: boolean
}

// Never expose pin_hash — every read goes through this projection.
const publicCols = { id: staff.id, name: staff.name, role: staff.role, isActive: staff.isActive }

export async function listStaff(dbc: Db = db): Promise<StaffSummary[]> {
  const rows = await dbc.select(publicCols).from(staff).orderBy(staff.name)
  return rows as StaffSummary[]
}

export async function createStaff(
  input: { name: string; pin: string; role?: StaffRole },
  dbc: Db = db,
): Promise<StaffSummary> {
  const pinHash = await bcrypt.hash(input.pin, 10)
  const [member] = await dbc.insert(staff)
    .values({ name: input.name, pinHash, role: input.role ?? 'staff' })
    .returning(publicCols)
  return member as StaffSummary
}

export interface StaffPatch {
  name?: string
  role?: StaffRole
  isActive?: boolean
  pin?: string
}

// Edits a staff member. Staff are never hard-deleted (sales/refunds/buys carry
// their staffId) — departures are handled by setting isActive = false. The one
// invariant we defend: the shop must always keep at least one active admin, so
// nobody can lock everyone out by demoting or deactivating the last one.
export async function updateStaff(
  id: number,
  patch: StaffPatch,
  dbc: Db = db,
): Promise<StaffSummary> {
  return dbc.transaction(async (tx) => {
    const [current] = await tx.select().from(staff).where(eq(staff.id, id)).limit(1)
    if (!current) throw new DomainError('NOT_FOUND', 'Staff member not found')

    const demoting = patch.role !== undefined && patch.role !== 'admin'
    const deactivating = patch.isActive === false
    if (current.isActive && current.role === 'admin' && (demoting || deactivating)) {
      const otherActiveAdmins = await tx.select({ id: staff.id }).from(staff)
        .where(and(eq(staff.role, 'admin'), eq(staff.isActive, true), ne(staff.id, id)))
      if (otherActiveAdmins.length === 0) {
        throw new DomainError('FORBIDDEN', 'Cannot remove the last active admin')
      }
    }

    const updates: Record<string, unknown> = {}
    if (patch.name !== undefined) updates.name = patch.name
    if (patch.role !== undefined) updates.role = patch.role
    if (patch.isActive !== undefined) updates.isActive = patch.isActive
    if (patch.pin !== undefined) updates.pinHash = await bcrypt.hash(patch.pin, 10)
    if (Object.keys(updates).length === 0) {
      throw new DomainError('INVALID_INPUT', 'No valid fields to update')
    }

    const [updated] = await tx.update(staff).set(updates).where(eq(staff.id, id)).returning(publicCols)
    return updated as StaffSummary
  })
}

export async function getOwnerPasswordHash(dbc: Db = db): Promise<string | null> {
  const [row] = await dbc.select({ hash: settings.ownerPasswordHash }).from(settings).limit(1)
  return row?.hash ?? null
}

export async function setOwnerPasswordHash(hash: string, dbc: Db = db): Promise<void> {
  // A fresh tenant DB has no settings row yet (Phase 2's /setup flow calls this
  // before anything else has lazily created one) — ensure it exists first, or
  // the UPDATE below silently affects 0 rows.
  await getSettings(dbc)
  await dbc.update(settings).set({ ownerPasswordHash: hash })
}

// Plan seat gating (spec §3.5): counts active staff only — deactivated
// members keep their history but free their seat.
export async function assertStaffSeatAvailable(
  ent: Entitlements,
  dbc: Db = db,
  opts: { reactivatingId?: number } = {},
): Promise<void> {
  if (ent.staffSeats === null) return
  if (opts.reactivatingId !== undefined) {
    const [target] = await dbc.select({ isActive: staff.isActive }).from(staff)
      .where(eq(staff.id, opts.reactivatingId)).limit(1)
    // Already active: no seat transition. Missing: let updateStaff report
    // NOT_FOUND rather than a misleading PLAN_LIMIT.
    if (!target || target.isActive) return
  }
  const active = await dbc.select({ id: staff.id }).from(staff).where(eq(staff.isActive, true))
  if (active.length >= ent.staffSeats) {
    throw new DomainError(
      'PLAN_LIMIT',
      `Your plan includes ${ent.staffSeats} staff seats — upgrade in Settings → Billing to add more`,
      { staffSeats: ent.staffSeats },
    )
  }
}
