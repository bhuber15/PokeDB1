'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { formatGBP, parsePounds, computeSaleTotals } from '@/lib/pricing'
import { CustomerPicker } from '@/components/shared/CustomerPicker'
import { useSettings } from '@/components/shared/SettingsProvider'
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
  onConfirm: (paymentMethod: string, discountAmount: number, expectedTotal: number, customerId?: number, cashReceived?: number) => Promise<void>
}

const QUICK_TENDER = [500, 1000, 2000, 5000] // pence: £5 £10 £20 £50

export function CheckoutDialog({ open, items, onClose, onConfirm }: CheckoutDialogProps) {
  const { vatScheme } = useSettings()
  const [method, setMethod] = useState('cash')
  const [discount, setDiscount] = useState('')
  const [received, setReceived] = useState('')
  const [loading, setLoading] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerBalance, setCustomerBalance] = useState<number | null>(null)

  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  // Same arithmetic as createSale — keeps expectedTotal in agreement with the server
  const { discount: discountAmount, vatAmount, total } = computeSaleTotals(subtotal, parsePounds(discount), vatScheme)

  const isCash = method === 'cash'
  // Blank tender = exact amount; otherwise change is due (or the tender is short)
  const receivedPence = isCash && received ? parsePounds(received) : null
  const changeDue = receivedPence != null ? receivedPence - total : null
  const tenderShort = changeDue != null && changeDue < 0

  const isStoreCredit = method === 'store_credit'
  const insufficientBalance = isStoreCredit && customer !== null && customerBalance !== null && customerBalance < total
  const confirmDisabled = loading || (isStoreCredit && !customer) || insufficientBalance || tenderShort

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
      // Attribute the sale to the selected customer for any payment method.
      await onConfirm(method, discountAmount, total, customer?.id, receivedPence ?? undefined)
    } finally {
      setLoading(false)
    }
    setDiscount('')
    setReceived('')
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

          {isCash && (
            <div>
              <Label htmlFor="checkout-received">Cash received (£) <span className="text-muted-foreground font-normal">— blank for exact</span></Label>
              <Input
                id="checkout-received"
                name="received"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={received}
                onChange={e => setReceived(e.target.value)}
                placeholder={(total / 100).toFixed(2)}
              />
              <div className="flex gap-1.5 mt-1.5">
                {QUICK_TENDER.filter(t => t >= total).slice(0, 3).map(t => (
                  <Button key={t} type="button" variant="outline" size="sm" className="h-7 text-xs flex-1"
                    onClick={() => setReceived((t / 100).toFixed(2))}>
                    {formatGBP(t)}
                  </Button>
                ))}
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs flex-1"
                  onClick={() => setReceived((total / 100).toFixed(2))}>
                  Exact
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Customer {isStoreCredit ? '' : <span className="text-muted-foreground font-normal">(optional)</span>}</Label>
            <CustomerPicker onSelect={handleCustomerSelect} selected={customer} />
            {isStoreCredit && !customer && (
              <p className="text-xs text-muted-foreground">Select a customer to pay with their store credit.</p>
            )}
            {!isStoreCredit && !customer && (
              <p className="text-xs text-muted-foreground">Attach a customer to record this sale in their purchase history.</p>
            )}
            {insufficientBalance && (
              <p className="text-xs text-destructive font-medium">
                Insufficient balance ({formatGBP(customerBalance ?? 0)}) — total is {formatGBP(total)}.
              </p>
            )}
          </div>

          <Separator />
          {discountAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Discount</span><span>-{formatGBP(discountAmount)}</span>
            </div>
          )}
          {vatAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>VAT (20%)</span><span>{formatGBP(vatAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-xl font-bold">
            <span>Total</span><span>{formatGBP(total)}</span>
          </div>
          {changeDue != null && (
            <div className={`flex justify-between text-lg font-bold ${tenderShort ? 'text-destructive' : 'text-emerald-400'}`}>
              <span>{tenderShort ? 'Short' : 'Change'}</span>
              <span>{formatGBP(Math.abs(changeDue))}</span>
            </div>
          )}
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
