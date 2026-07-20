'use client'
import { useState } from 'react'
import { MinusIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatGBP } from '@/lib/pricing'
import { PRODUCT_CATEGORY_LABELS, type ProductCategory } from '@/lib/product-categories'
import type { Product } from '@/lib/db/schema'

interface ProductResultProps {
  product: Product
  itemId: number
  quantity: number
  price: number // pence — the stock row's sellPriceOverride (always set for products)
  onAddToCart: (itemId: number, name: string, condition: string, price: number, qty: number) => void
}

export function ProductResult({ product, itemId, quantity, price, onAddToCart }: ProductResultProps) {
  const [qty, setQty] = useState(1)
  const label = PRODUCT_CATEGORY_LABELS[product.category as ProductCategory] ?? product.category

  return (
    <div className="border rounded-xl p-4 space-y-3 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold leading-tight">{product.name}</h2>
          <p className="text-sm text-muted-foreground">
            {label}{product.ean ? ` · ${product.ean}` : ''} · {quantity} in stock
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 pt-1 border-t">
        <span className="text-2xl font-bold">{formatGBP(price)}</span>
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="outline" size="sm" aria-label="Decrease quantity" onClick={() => setQty(q => Math.max(1, q - 1))}><MinusIcon className="size-3.5" aria-hidden="true" /></Button>
          <span className="w-8 text-center font-semibold tabular-nums">{qty}</span>
          <Button variant="outline" size="sm" aria-label="Increase quantity" onClick={() => setQty(q => Math.min(quantity, q + 1))}><PlusIcon className="size-3.5" aria-hidden="true" /></Button>
          <Button disabled={price <= 0} onClick={() => onAddToCart(itemId, product.name, label, price, qty)}>
            Add to Cart
          </Button>
        </div>
      </div>
    </div>
  )
}
