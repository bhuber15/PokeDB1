import { eq, isNull, and, inArray, desc } from 'drizzle-orm'
import { db, type Db } from '@/lib/db'
import { wantList, cards, customers, inventoryItems } from '@/lib/db/schema'
import { DomainError } from './errors'
import type { WantRow } from '@/lib/wants-grouping'

// Every open want (fulfilledAt IS NULL), enriched with customer contact + card
// info, plus an inStock flag derived from active inventory for the card.
export async function listOpenWants(dbc: Db = db): Promise<WantRow[]> {
  const wants = await dbc
    .select({
      id: wantList.id,
      customerId: wantList.customerId,
      cardId: wantList.cardId,
      freeText: wantList.freeText,
      notify: wantList.notify,
      createdAt: wantList.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      cardName: cards.name,
      cardSetName: cards.setName,
      cardSetNumber: cards.setNumber,
    })
    .from(wantList)
    .leftJoin(customers, eq(wantList.customerId, customers.id))
    .leftJoin(cards, eq(wantList.cardId, cards.id))
    .where(isNull(wantList.fulfilledAt))
    .orderBy(desc(wantList.createdAt))

  const cardIds = wants.map(w => w.cardId).filter((id): id is number => id != null)

  let inStockSet = new Set<number>()
  if (cardIds.length > 0) {
    const activeRows = await dbc
      .select({ cardId: inventoryItems.cardId })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.isActive, true), inArray(inventoryItems.cardId, cardIds)))
    inStockSet = new Set(activeRows.map(r => r.cardId).filter((id): id is number => id != null))
  }

  return wants.map(w => ({
    ...w,
    inStock: w.cardId != null ? inStockSet.has(w.cardId) : false,
  }))
}

// Count of open wants that are sellable right now — powers the nav badge.
export async function countInStockWants(dbc: Db = db): Promise<number> {
  const wants = await listOpenWants(dbc)
  return wants.filter(w => w.inStock).length
}

// Toggle whether the customer should be contacted when their want is in stock.
export async function setWantNotify(id: number, notify: boolean, dbc: Db = db): Promise<void> {
  const [row] = await dbc
    .update(wantList)
    .set({ notify })
    .where(and(eq(wantList.id, id), isNull(wantList.fulfilledAt)))
    .returning({ id: wantList.id })
  if (!row) throw new DomainError('NOT_FOUND', 'Want not found')
}

export interface NotificationResult {
  sent: boolean
  reason: 'provider_not_configured'
  wantId: number
}

// Phase-2 seam: the single place a real email/SMS provider will plug in. No
// provider is wired yet, so this sends nothing and reports why. Intentionally
// not called from any route in this build.
export async function sendWantInStockNotification(
  want: WantRow,
  dbc: Db = db,
): Promise<NotificationResult> {
  void dbc // reserved for the future provider lookup / audit write
  return { sent: false, reason: 'provider_not_configured', wantId: want.id }
}
