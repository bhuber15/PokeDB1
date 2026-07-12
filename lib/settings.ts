import { db, isMultiTenant, type Db } from '@/lib/db'
import { settings, type Settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { parsePounds } from '@/lib/pricing'
import { BRAND } from '@/lib/brand'

export interface AppSettings {
  shopName: string
  usdToGbp: number
  eurToGbp: number
  marginMultiplier: number
  highValueThreshold: number // pence
  buyCashPct: number
  buyCreditPct: number
  primaryPriceSource: 'cardmarket' | 'tcgplayer'
  vatScheme: 'none' | 'standard' | 'margin'
  marginNoCostHandling: 'exclude' | 'block'
}

// Defaults fall back to env so pricing still works before the row exists
// or if the DB is briefly unreachable.
export const DEFAULT_SETTINGS: AppSettings = {
  shopName: BRAND.name,
  usdToGbp: parseFloat(process.env.PRICE_USD_TO_GBP ?? process.env.NEXT_PUBLIC_USD_TO_GBP ?? '0.79') || 0.79,
  eurToGbp: parseFloat(process.env.PRICE_EUR_TO_GBP ?? process.env.NEXT_PUBLIC_EUR_TO_GBP ?? '0.86') || 0.86,
  marginMultiplier: parseFloat(process.env.MARGIN_MULTIPLIER ?? '0.85') || 0.85,
  highValueThreshold: parsePounds(process.env.HIGH_VALUE_THRESHOLD ?? '50') || 5000, // env is pounds

  buyCashPct: 0.5,
  buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket',
  vatScheme: 'none',
  marginNoCostHandling: 'exclude',
}

function toAppSettings(row: Settings): AppSettings {
  return {
    shopName: row.shopName,
    usdToGbp: row.usdToGbp,
    eurToGbp: row.eurToGbp,
    marginMultiplier: row.marginMultiplier,
    highValueThreshold: row.highValueThreshold,
    buyCashPct: row.buyCashPct,
    buyCreditPct: row.buyCreditPct,
    primaryPriceSource: row.primaryPriceSource as 'cardmarket' | 'tcgplayer',
    vatScheme: row.vatScheme as 'none' | 'standard' | 'margin',
    marginNoCostHandling: row.marginNoCostHandling as 'exclude' | 'block',
  }
}

// Reads the single settings row, lazily creating it with defaults on first call.
// Degrades to DEFAULT_SETTINGS if the DB is unreachable so the app never crashes.
export async function getSettings(dbc: Db = db): Promise<AppSettings> {
  try {
    const [row] = await dbc.select().from(settings).where(eq(settings.id, 1)).limit(1)
    if (row) return toAppSettings(row)

    const [created] = await dbc.insert(settings)
      .values({ id: 1, ...DEFAULT_SETTINGS })
      .onConflictDoNothing()
      .returning()
    if (created) return toAppSettings(created)

    // A concurrent call created it — read again.
    const [row2] = await dbc.select().from(settings).where(eq(settings.id, 1)).limit(1)
    return row2 ? toAppSettings(row2) : DEFAULT_SETTINGS
  } catch (e) {
    // Single-tenant: a briefly unreachable DB falls back to defaults. Multi-tenant:
    // silently serving another shop's defaults would mis-tax sales — fail loudly.
    if (isMultiTenant()) throw e
    return DEFAULT_SETTINGS
  }
}

export async function updateSettings(patch: Partial<AppSettings>, dbc: Db = db): Promise<AppSettings> {
  await getSettings(dbc) // ensure the row exists
  const [updated] = await dbc.update(settings)
    .set({ ...patch, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    .where(eq(settings.id, 1))
    .returning()
  return toAppSettings(updated)
}
