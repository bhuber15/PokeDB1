'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { parsePounds } from '@/lib/pricing'
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from '@/lib/product-categories'
import type { Product } from '@/lib/db/schema'
import type { BuyCartLine } from './BuyCart'

// Buying a product in: no condition ladder, no market offer — the pay price
// is the whole judgement (a battered box gets a lower offer, not a grade).
// Cash and credit prices are the same number: with no market reference there
// is nothing for the cash/credit percentages to derive from.
export function ProductBuyRow({ product, onAdd }: { product: Product; onAdd: (line: BuyCartLine) => void }) {
  const [qty, setQty] = useState(1)
  const [price, setPrice] = useState('')
  const pence = price ? parsePounds(price) : null
  const valid = pence != null && pence >= 0 && qty >= 1

  return (
    <div className="border rounded-xl p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{product.name}</div>
        <div className="text-sm text-muted-foreground flex gap-2 items-center">
          <Badge variant="outline" className="text-xs py-0">
            {PRODUCT_CATEGORY_LABELS[product.category as ProductCategory] ?? product.category}
          </Badge>
          {product.ean && <span className="text-xs">{product.ean}</span>}
        </div>
      </div>
      <Input
        aria-label="Quantity"
        type="number" min={1} value={qty}
        onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
        className="w-16 text-right"
      />
      <Input
        aria-label="Pay price (£ each)"
        type="number" inputMode="decimal" step="0.01" min="0" placeholder="£ each"
        value={price} onChange={e => setPrice(e.target.value)}
        className="w-24 text-right"
      />
      <Button
        disabled={!valid}
        onClick={() => valid && onAdd({
          productId: product.id, cardName: product.name, quantity: qty,
          payPriceCash: pence, payPriceCredit: pence,
        })}
      >
        Add
      </Button>
    </div>
  )
}
