// Pure, dependency-free helper shared between the wants API row shape (server)
// and the client WantsPanel. Keep it free of any lib/db import so it never
// drags the DB client into a browser bundle (see lib/adjustment-reasons.ts).

export interface WantRow {
  id: number
  customerId: number
  cardId: number | null
  freeText: string | null
  notify: boolean
  createdAt: string
  customerName: string | null
  customerPhone: string | null
  customerEmail: string | null
  cardName: string | null
  cardSetName: string | null
  cardSetNumber: string | null
  inStock: boolean
}

export interface InStockCustomer {
  customerId: number
  wantId: number
  name: string | null
  phone: string | null
  email: string | null
  notify: boolean
}

export interface InStockCardGroup {
  cardId: number
  cardName: string | null
  label: string
  customers: InStockCustomer[]
}

export function cardLabel(
  w: Pick<WantRow, 'cardName' | 'cardSetName' | 'cardSetNumber' | 'freeText'>,
): string {
  if (w.cardName) {
    return `${w.cardName}${w.cardSetName ? ` — ${w.cardSetName}` : ''}${w.cardSetNumber ? ` #${w.cardSetNumber}` : ''}`
  }
  return w.freeText ?? '(unknown)'
}

// One entry per card for wants that are carded AND in stock. Groups collapse
// multiple interested customers under a single card. Deterministic ordering so
// the UI (and tests) are stable.
export function groupInStockWants(wants: WantRow[]): InStockCardGroup[] {
  const byCard = new Map<number, InStockCardGroup>()
  for (const w of wants) {
    if (!w.inStock || w.cardId == null) continue
    let group = byCard.get(w.cardId)
    if (!group) {
      group = { cardId: w.cardId, cardName: w.cardName, label: cardLabel(w), customers: [] }
      byCard.set(w.cardId, group)
    }
    group.customers.push({
      customerId: w.customerId,
      wantId: w.id,
      name: w.customerName,
      phone: w.customerPhone,
      email: w.customerEmail,
      notify: w.notify,
    })
  }
  const groups = [...byCard.values()]
  groups.sort((a, b) => a.label.localeCompare(b.label))
  for (const g of groups) {
    g.customers.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }
  return groups
}
