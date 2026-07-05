'use client'
import { XIcon, MinusIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatGBP } from '@/lib/pricing'

export interface CartItem {
  inventoryItemId: number
  name: string
  condition: string
  price: number
  quantity: number
}

interface CartProps {
  items: CartItem[]
  onRemove: (inventoryItemId: number) => void
  onQtyChange: (inventoryItemId: number, delta: number) => void
  onCheckout: () => void
}

export function Cart({ items, onRemove, onQtyChange, onCheckout }: CartProps) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)

  if (items.length === 0) {
    return (
      <div className="border rounded-xl p-8 text-center text-muted-foreground text-sm">
        Cart is empty<br />Scan or search a card to begin
      </div>
    )
  }

  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="divide-y">
        {items.map(item => (
          <div key={item.inventoryItemId} className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{item.name}</div>
              <div className="flex items-center gap-1.5 mt-0.5 text-sm text-muted-foreground">
                <span>{item.condition}</span>
                <Button variant="outline" size="sm" className="h-5 w-5 p-0"
                  aria-label={`Decrease quantity of ${item.name}`}
                  disabled={item.quantity <= 1}
                  onClick={() => onQtyChange(item.inventoryItemId, -1)}>
                  <MinusIcon className="size-3" aria-hidden="true" />
                </Button>
                <span className="w-5 text-center tabular-nums text-foreground">{item.quantity}</span>
                <Button variant="outline" size="sm" className="h-5 w-5 p-0"
                  aria-label={`Increase quantity of ${item.name}`}
                  onClick={() => onQtyChange(item.inventoryItemId, 1)}>
                  <PlusIcon className="size-3" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="font-semibold shrink-0">{formatGBP(item.price * item.quantity)}</div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(item.inventoryItemId)}
              aria-label={`Remove ${item.name} from cart`}
            >
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
      <div className="p-4 border-t bg-muted/20">
        <div className="flex justify-between items-center mb-4">
          <span className="font-semibold">Subtotal</span>
          <span className="text-xl font-bold">{formatGBP(subtotal)}</span>
        </div>
        <Button className="w-full h-11 text-base" onClick={onCheckout}>
          Checkout
        </Button>
      </div>
    </div>
  )
}
