'use client'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { XIcon } from 'lucide-react'
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

const MAX_SPLIT_LINES = 4

export interface CheckoutConfirmOptions {
  paymentMethod?: string
  payments?: { method: string; amount: number }[]
  discountAmount: number
  expectedTotal: number
  customerId?: number
  cashReceived?: number
}

interface CheckoutDialogProps {
  open: boolean
  items: CartItem[]
  onClose: () => void
  onConfirm: (opts: CheckoutConfirmOptions) => Promise<void>
}

const QUICK_TENDER = [500, 1000, 2000, 5000] // pence: £5 £10 £20 £50

interface SplitRow {
  method: string
  amount: string // pounds, as typed
}

export function CheckoutDialog({ open, items, onClose, onConfirm }: CheckoutDialogProps) {
  const { vatScheme } = useSettings()
  const [method, setMethod] = useState('cash')
  const [splitMode, setSplitMode] = useState(false)
  const [splitRows, setSplitRows] = useState<SplitRow[]>([
    { method: 'cash', amount: '' },
    { method: 'card', amount: '' },
  ])
  const [discount, setDiscount] = useState('')
  const [received, setReceived] = useState('')
  const [loading, setLoading] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [customerBalance, setCustomerBalance] = useState<number | null>(null)

  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  // Same arithmetic as createSale — keeps expectedTotal in agreement with the server
  const { discount: discountAmount, vatAmount, total } = computeSaleTotals(subtotal, parsePounds(discount), vatScheme)

  const isCash = !splitMode && method === 'cash'
  // Blank tender = exact amount; otherwise change is due (or the tender is short)
  const receivedPence = isCash && received ? parsePounds(received) : null
  const changeDue = receivedPence != null ? receivedPence - total : null
  const tenderShort = changeDue != null && changeDue < 0

  // Split-tender state: pence per row, remaining due, credit portion
  const splitPence = splitRows.map(r => (r.amount ? parsePounds(r.amount) : 0))
  const splitSum = splitPence.reduce((s, p) => s + p, 0)
  const splitRemaining = total - splitSum
  const splitInvalidRow = splitRows.some((r, i) => r.amount !== '' && splitPence[i] <= 0)
  const splitIncomplete = splitRows.some(r => r.amount === '')
  const creditPortion = splitMode
    ? splitRows.reduce((s, r, i) => s + (r.method === 'store_credit' ? splitPence[i] : 0), 0)
    : (method === 'store_credit' ? total : 0)

  const usesStoreCredit = creditPortion > 0 || (!splitMode && method === 'store_credit')
    || (splitMode && splitRows.some(r => r.method === 'store_credit'))
  const insufficientBalance = usesStoreCredit && customer !== null && customerBalance !== null
    && customerBalance < (splitMode ? creditPortion : total)

  const splitBlocked = splitMode && (splitRemaining !== 0 || splitInvalidRow || splitIncomplete)
  const confirmDisabled = loading
    || (usesStoreCredit && !customer)
    || insufficientBalance
    || tenderShort
    || splitBlocked

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

  function setSplitRow(i: number, patch: Partial<SplitRow>) {
    setSplitRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function fillRemainder(i: number) {
    const others = splitPence.reduce((s, p, idx) => (idx === i ? s : s + p), 0)
    const rest = total - others
    setSplitRow(i, { amount: rest > 0 ? (rest / 100).toFixed(2) : '' })
  }

  function resetState() {
    setDiscount('')
    setReceived('')
    setMethod('cash')
    setSplitMode(false)
    setSplitRows([{ method: 'cash', amount: '' }, { method: 'card', amount: '' }])
    setCustomer(null)
    setCustomerBalance(null)
  }

  async function confirm() {
    setLoading(true)
    try {
      // Attribute the sale to the selected customer for any payment method.
      await onConfirm(splitMode
        ? {
            payments: splitRows.map((r, i) => ({ method: r.method, amount: splitPence[i] })),
            discountAmount,
            expectedTotal: total,
            customerId: customer?.id,
          }
        : {
            paymentMethod: method,
            discountAmount,
            expectedTotal: total,
            customerId: customer?.id,
            cashReceived: receivedPence ?? undefined,
          })
    } finally {
      setLoading(false)
    }
    resetState()
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
            <div className="flex items-center justify-between mb-2">
              <Label>Payment Method</Label>
              <Button
                type="button"
                variant={splitMode ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setSplitMode(s => !s)}
              >
                Split payment
              </Button>
            </div>
            {!splitMode ? (
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
            ) : (
              <div className="space-y-2">
                {splitRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={row.method}
                      onChange={e => setSplitRow(i, { method: e.target.value })}
                      className="h-9 rounded-md border bg-transparent px-2 text-sm flex-1"
                      aria-label={`Payment method ${i + 1}`}
                    >
                      {PAYMENT_METHODS.map(m => (
                        // One store-credit line max: hide the option elsewhere once used
                        (m.value !== 'store_credit' || row.method === 'store_credit'
                          || !splitRows.some(r => r.method === 'store_credit')) && (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        )
                      ))}
                    </select>
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={row.amount}
                      onChange={e => setSplitRow(i, { amount: e.target.value })}
                      placeholder="0.00"
                      className="w-24 text-right"
                      aria-label={`Amount ${i + 1} (£)`}
                    />
                    <Button type="button" variant="outline" size="sm" className="h-9 text-xs px-2"
                      onClick={() => fillRemainder(i)}>
                      Rest
                    </Button>
                    {splitRows.length > 2 && (
                      <Button type="button" variant="ghost" size="sm" className="h-9 px-2"
                        onClick={() => setSplitRows(rows => rows.filter((_, idx) => idx !== i))}
                        aria-label={`Remove payment ${i + 1}`}>
                        <XIcon className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  {splitRows.length < MAX_SPLIT_LINES ? (
                    <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => setSplitRows(rows => [...rows, { method: 'cash', amount: '' }])}>
                      + Add method
                    </Button>
                  ) : <span />}
                  <span className={`text-sm font-medium ${splitRemaining === 0 && !splitInvalidRow ? 'text-emerald-400' : 'text-destructive'}`}>
                    {splitRemaining === 0 ? 'Fully allocated' : splitRemaining > 0
                      ? `${formatGBP(splitRemaining)} left`
                      : `${formatGBP(-splitRemaining)} over`}
                  </span>
                </div>
              </div>
            )}
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
            <Label>Customer {usesStoreCredit ? '' : <span className="text-muted-foreground font-normal">(optional)</span>}</Label>
            <CustomerPicker onSelect={handleCustomerSelect} selected={customer} />
            {usesStoreCredit && !customer && (
              <p className="text-xs text-muted-foreground">Select a customer to pay with their store credit.</p>
            )}
            {!usesStoreCredit && !customer && (
              <p className="text-xs text-muted-foreground">Attach a customer to record this sale in their purchase history.</p>
            )}
            {insufficientBalance && (
              <p className="text-xs text-destructive font-medium">
                Insufficient balance ({formatGBP(customerBalance ?? 0)}) — {splitMode
                  ? `credit portion is ${formatGBP(creditPortion)}`
                  : `total is ${formatGBP(total)}`}.
              </p>
            )}
          </div>

          <Separator />
          {discountAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Discount</span><span>-{formatGBP(discountAmount)}</span>
            </div>
          )}
          {vatScheme === 'standard' && vatAmount > 0 && (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>VAT (20%)</span><span>{formatGBP(vatAmount)}</span>
            </div>
          )}
          {vatScheme === 'margin' && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>VAT Margin Scheme</span><span>included</span>
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
