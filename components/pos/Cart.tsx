'use client'
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
  onCheckout: () => void
}

export function Cart({ items, onRemove, onCheckout }: CartProps) {
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
              <div className="text-sm text-muted-foreground">{item.condition} × {item.quantity}</div>
            </div>
            <div className="font-semibold shrink-0">{formatGBP(item.price * item.quantity)}</div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(item.inventoryItemId)}
            >
              ✕
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
          Checkout →
        </Button>
      </div>
    </div>
  )
}
