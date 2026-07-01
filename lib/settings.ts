import { db } from '@/lib/db'
import { settings, type Settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export interface AppSettings {
  shopName: string
  usdToGbp: number
  eurToGbp: number
  marginMultiplier: number
  highValueThreshold: number
  buyCashPct: number
  buyCreditPct: number
  primaryPriceSource: 'cardmarket' | 'tcgplayer'
}

// Defaults fall back to env so pricing still works before the row exists
// or if the DB is briefly unreachable.
export const DEFAULT_SETTINGS: AppSettings = {
  shopName: 'PokeDB',
  usdToGbp: parseFloat(process.env.PRICE_USD_TO_GBP ?? '0.79') || 0.79,
  eurToGbp: parseFloat(process.env.PRICE_EUR_TO_GBP ?? '0.86') || 0.86,
  marginMultiplier: parseFloat(process.env.MARGIN_MULTIPLIER ?? '0.85') || 0.85,
  highValueThreshold: parseFloat(process.env.HIGH_VALUE_THRESHOLD ?? '50') || 50,
  buyCashPct: 0.5,
  buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket',
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
  }
}

// Reads the single settings row, lazily creating it with defaults on first call.
// Degrades to DEFAULT_SETTINGS if the DB is unreachable so the app never crashes.
export async function getSettings(): Promise<AppSettings> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1)
    if (row) return toAppSettings(row)

    const [created] = await db.insert(settings)
      .values({ id: 1, ...DEFAULT_SETTINGS })
      .onConflictDoNothing()
      .returning()
    if (created) return toAppSettings(created)

    // A concurrent call created it — read again.
    const [row2] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1)
    return row2 ? toAppSettings(row2) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  await getSettings() // ensure the row exists
  const [updated] = await db.update(settings)
    .set({ ...patch, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    .where(eq(settings.id, 1))
    .returning()
  return toAppSettings(updated)
}
