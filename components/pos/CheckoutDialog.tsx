'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { formatGBP } from '@/lib/pricing'
import type { CartItem } from './Cart'

const PAYMENT_METHODS = [
  { value: 'cash', label: '💵 Cash' },
  { value: 'card', label: '💳 Card' },
  { value: 'store_credit', label: '🏪 Store Credit' },
  { value: 'other', label: 'Other' },
]

interface CheckoutDialogProps {
  open: boolean
  items: CartItem[]
  onClose: () => void
  onConfirm: (paymentMethod: string, discountAmount: number) => Promise<void>
}

export function CheckoutDialog({ open, items, onClose, onConfirm }: CheckoutDialogProps) {
  const [method, setMethod] = useState('cash')
  const [discount, setDiscount] = useState('')
  const [loading, setLoading] = useState(false)

  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  const discountAmount = Math.min(parseFloat(discount) || 0, subtotal)
  const total = subtotal - discountAmount

  async function confirm() {
    setLoading(true)
    await onConfirm(method, discountAmount)
    setLoading(false)
    setDiscount('')
    setMethod('cash')
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Checkout</DialogTitle>
        <div className="space-y-4">
          <div className="border rounded-lg divide-y text-sm max-h-48 overflow-y-auto">
            {items.map(item => (
              <div key={item.inventoryItemId} className="flex justify-between p-2">
                <span className="text-muted-foreground">{item.name} ({item.condition}) ×{item.quantity}</span>
                <span className="font-medium">{formatGBP(item.price * item.quantity)}</span>
              </div>
            ))}
          </div>
          <div>
            <Label>Discount (£)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={discount}
              onChange={e => setDiscount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label className="mb-2 block">Payment Method</Label>
            <div className="flex gap-2">
              {PAYMENT_METHODS.map(m => (
                <Button
                  key={m.value}
                  variant={method === m.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMethod(m.value)}
                >
                  {m.label}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          {discountAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Discount</span><span>-{formatGBP(discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-xl font-bold">
            <span>Total</span><span>{formatGBP(total)}</span>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={confirm} disabled={loading} className="flex-1">
            {loading ? 'Processing…' : `Confirm ${formatGBP(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
