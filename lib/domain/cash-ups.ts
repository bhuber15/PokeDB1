// lib/domain/cash-ups.ts
//
// End-of-day till close. closeCashUp snapshots the day's cash movements
// (via getCashUpSummary) together with the counted drawer, so the close is a
// permanent record even if late transactions land on that day afterwards.
// All money is integer pence (GBP).

import { desc, eq } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { cashUps, staff, type CashUp } from '@/lib/db/schema'
import { getCashUpSummary } from './reports'
import { DomainError, isUniqueViolation } from './errors'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface CloseCashUpInput {
  staffId: number
  day: string // YYYY-MM-DD
  openingFloat: number // pence, ≥ 0
  countedCash: number // pence, ≥ 0
  notes?: string
}

export async function closeCashUp(input: CloseCashUpInput, dbc: Db = db): Promise<CashUp> {
  if (!DAY_RE.test(input.day)) throw new DomainError('INVALID_INPUT', 'day must be YYYY-MM-DD')
  for (const field of ['openingFloat', 'countedCash'] as const) {
    const v = input[field]
    if (!Number.isInteger(v) || v < 0) {
      throw new DomainError('INVALID_INPUT', `${field} must be a non-negative integer (pence)`)
    }
  }

  const summary = await getCashUpSummary(input.day, dbc)
  const expectedCash = input.openingFloat + summary.cashSales - summary.cashRefunds - summary.cashBuyPayouts
  const variance = input.countedCash - expectedCash

  try {
    const [record] = await dbc.insert(cashUps).values({
      day: input.day,
      staffId: input.staffId,
      openingFloat: input.openingFloat,
      cashSales: summary.cashSales,
      cashRefunds: summary.cashRefunds,
      cashBuyPayouts: summary.cashBuyPayouts,
      expectedCash,
      countedCash: input.countedCash,
      variance,
      notes: input.notes?.trim() || null,
    }).returning()
    return record
  } catch (e) {
    // The unique index is the race-safe guard; map it to a domain error.
    if (isUniqueViolation(e, 'cash_ups.day')) {
      throw new DomainError('CASH_UP_EXISTS', `Day ${input.day} is already closed`, { day: input.day })
    }
    throw e
  }
}

export interface CashUpRecord extends CashUp {
  staffName: string | null
}

export async function getCashUpForDay(day: string, dbc: Db = db): Promise<CashUpRecord | null> {
  if (!DAY_RE.test(day)) throw new DomainError('INVALID_INPUT', 'day must be YYYY-MM-DD')
  const [row] = await dbc
    .select({ cashUp: cashUps, staffName: staff.name })
    .from(cashUps)
    .leftJoin(staff, eq(cashUps.staffId, staff.id))
    .where(eq(cashUps.day, day))
    .limit(1)
  return row ? { ...row.cashUp, staffName: row.staffName ?? null } : null
}

export async function listCashUps(limit = 14, dbc: Db = db): Promise<CashUpRecord[]> {
  const rows = await dbc
    .select({ cashUp: cashUps, staffName: staff.name })
    .from(cashUps)
    .leftJoin(staff, eq(cashUps.staffId, staff.id))
    .orderBy(desc(cashUps.day))
    .limit(limit)
  return rows.map(r => ({ ...r.cashUp, staffName: r.staffName ?? null }))
}
