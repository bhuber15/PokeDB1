// Reconciles the POS page's visible search results with a sale that just
// completed, without a re-fetch: the till knows exactly what left the shelf.
// Client-safe and dependency-free (see the client-bundle rule in AGENTS.md).

export interface SoldLine {
  inventoryItemId: number
  quantity: number
}

// Card results keep their row even when every option sells out — CardResult
// renders an explicit "No stock available" state, which tells the cashier
// the sale emptied the shelf rather than silently hiding the card.
export function applySaleToCardResults<
  O extends { itemId: number; quantity: number },
  R extends { inventoryOptions: O[] },
>(results: R[], sold: SoldLine[]): R[] {
  const soldByItem = new Map(sold.map(s => [s.inventoryItemId, s.quantity]))
  return results.map(r => ({
    ...r,
    inventoryOptions: r.inventoryOptions
      .map(o => {
        const q = soldByItem.get(o.itemId)
        return q ? { ...o, quantity: o.quantity - q } : o
      })
      .filter(o => o.quantity > 0),
  }))
}

// Product rows are dropped at zero — ProductResult has no out-of-stock
// rendering, matching how a fresh search omits empty stock rows.
export function applySaleToProductResults<P extends { itemId: number; quantity: number }>(
  products: P[], sold: SoldLine[],
): P[] {
  const soldByItem = new Map(sold.map(s => [s.inventoryItemId, s.quantity]))
  return products
    .map(p => {
      const q = soldByItem.get(p.itemId)
      return q ? { ...p, quantity: p.quantity - q } : p
    })
    .filter(p => p.quantity > 0)
}
