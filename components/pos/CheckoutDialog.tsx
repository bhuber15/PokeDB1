'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { formatGBP } from '@/lib/pricing'
import { CustomerPicker } from '@/components/shared/CustomerPicker'
import type { CartItem } from './Cart'
import type { Customer } from '@/lib/db/schema'

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
  onConfirm: (paymentMethod: string, discountAmount: number, expectedTotal: number, customerId?: number) => Promise<void>
}

export function CheckoutDialog({ open, items, onClose, onConfirm }: CheckoutDialogProps) {
  const [method, setMethod] = useState('cash')
  const [discount, setDiscount] = useState('')
  const [loading, setLoading] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerBalance, setCustomerBalance] = useState<number | null>(null)

  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  const discountAmount = Math.min(parseFloat(discount) || 0, subtotal)
  const total = subtotal - discountAmount

  const isStoreCredit = method === 'store_credit'
  const insufficientBalance = isStoreCredit && customer !== null && customerBalance !== null && customerBalance < total
  const confirmDisabled = loading || (isStoreCredit && !customer) || insufficientBalance

  // When CustomerPicker calls onSelect, also fetch the balance so we can
  // access it here for the balance guard. CustomerPicker shows the balance
  // in its own UI; we also need it to check sufficiency.
  function handleCustomerSelect(c: Customer | null) {
    setCustomer(c)
    setCustomerBalance(null)
    if (c) {
      fetch(`/api/customers/${c.id}`)
        .then(r => r.json())
        .then((data: { balance: number }) => setCustomerBalance(data.balance ?? null))
        .catch(() => setCustomerBalance(null))
    }
  }

  async function confirm() {
    setLoading(true)
    try {
      await onConfirm(method, discountAmount, total, isStoreCredit && customer ? customer.id : undefined)
    } finally {
      setLoading(false)
    }
    setDiscount('')
    setMethod('cash')
    setCustomer(null)
    setCustomerBalance(null)
  }

  function handleClose() {
    setCustomer(null)
    setCustomerBalance(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
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
            <Label htmlFor="checkout-discount">Discount (£)</Label>
            <Input
              id="checkout-discount"
              name="discount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={discount}
              onChange={e => setDiscount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label className="mb-2 block">Payment Method</Label>
            <div className="flex flex-wrap gap-2">
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

          {isStoreCredit && (
            <div className="space-y-2">
              <Label>Customer</Label>
              <CustomerPicker onSelect={handleCustomerSelect} selected={customer} />
              {!customer && (
                <p className="text-xs text-muted-foreground">Select a customer to pay with their store credit.</p>
              )}
              {insufficientBalance && (
                <p className="text-xs text-destructive font-medium">
                  Insufficient balance ({formatGBP(customerBalance ?? 0)}) — total is {formatGBP(total)}.
                </p>
              )}
            </div>
          )}

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
          <Button variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
          <Button onClick={confirm} disabled={confirmDisabled} className="flex-1">
            {loading ? 'Processing…' : `Confirm ${formatGBP(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
