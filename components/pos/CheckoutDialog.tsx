'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { XIcon } from 'lucide-react'
import { formatGBP, parsePounds, computeSaleTotals } from '@/lib/pricing'
import { CustomerPicker } from '@/components/shared/CustomerPicker'
import { useSettings } from '@/components/shared/SettingsProvider'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'
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
  // Preselected customer for the trade-in handoff (/pos?customerId=N). The
  // POS page owns this; clearing the banner there stops the preselection.
  initialCustomer?: Customer | null
}

const QUICK_TENDER = [500, 1000, 2000, 5000] // pence: £5 £10 £20 £50

interface SplitRow {
  method: string
  amount: string // pounds, as typed
}

export function CheckoutDialog({ open, items, onClose, onConfirm, initialCustomer }: CheckoutDialogProps) {
  const { vatScheme } = useSettings()
  const online = useOnlineStatus()
  const [method, setMethod] = useState('cash')
  const [splitMode, setSplitMode] = useState(false)
  const [splitRows, setSplitRows] = useState<SplitRow[]>([
    { method: 'cash', amount: '' },
    { method: 'card', amount: '' },
  ])
  const [discount, setDiscount] = useState('')
  const [received, setReceived] = useState('')
  const [loading, setLoading] = useState(false)
  // 'unset' = staff haven't touched the picker this open-cycle, so the
  // trade-in handoff customer (if any) applies; picking or clearing overrides
  // it until the dialog resets. Derived, so no state-syncing effect is needed.
  const [customerOverride, setCustomerOverride] = useState<Customer | null | 'unset'>('unset')
  const customer = customerOverride === 'unset' ? initialCustomer ?? null : customerOverride
  // Balance is derived from the last fetch result so a slow response for a
  // previously selected customer can never show against the current one
  // (same pattern as CustomerPicker).
  const [balanceInfo, setBalanceInfo] = useState<{ customerId: number; balance: number | null } | null>(null)
  const customerBalance = customer != null && balanceInfo?.customerId === customer.id
    ? balanceInfo.balance : null

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
    || (!online && usesStoreCredit)

  // Fetch the balance whichever way a customer arrives (picker or trade-in
  // handoff). CustomerPicker shows the balance in its own UI; we also need it
  // here for the sufficiency guard and the apply-credit shortcut.
  useEffect(() => {
    const id = customer?.id
    if (id == null) return
    let stale = false
    fetch(`/api/customers/${id}`)
      .then(r => r.json())
      .then((data: { balance: number }) => { if (!stale) setBalanceInfo({ customerId: id, balance: data.balance ?? null }) })
      .catch(() => { if (!stale) setBalanceInfo({ customerId: id, balance: null }) })
    return () => { stale = true }
  }, [customer?.id])

  // One-tap trade-in settlement: cover as much of the total as the balance
  // allows; any remainder becomes a card line staff can retender. Amounts are
  // display strings here — the server re-verifies both balance and sum.
  function applyStoreCredit() {
    if (customerBalance == null || customerBalance <= 0 || total <= 0) return
    const credit = Math.min(customerBalance, total)
    if (credit >= total) {
      setSplitMode(false)
      setMethod('store_credit')
    } else {
      setSplitMode(true)
      setSplitRows([
        { method: 'store_credit', amount: (credit / 100).toFixed(2) },
        { method: 'card', amount: ((total - credit) / 100).toFixed(2) },
      ])
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
    setCustomerOverride('unset')
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
    setCustomerOverride('unset')
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
                    disabled={!online && m.value === 'store_credit'}
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
                          <option key={m.value} value={m.value} disabled={!online && m.value === 'store_credit'}>
                            {m.label}
                          </option>
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
            <CustomerPicker onSelect={c => setCustomerOverride(c)} selected={customer} />
            {usesStoreCredit && !customer && (
              <p className="text-xs text-muted-foreground">Select a customer to pay with their store credit.</p>
            )}
            {customer && !usesStoreCredit && customerBalance != null && customerBalance > 0 && total > 0 && (
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={applyStoreCredit}>
                Apply store credit — {formatGBP(Math.min(customerBalance, total))}
                {customerBalance < total ? ', rest by card' : ''}
              </Button>
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
        {!online && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Offline — this sale will queue and send automatically when the connection returns.
            {usesStoreCredit && ' Store credit needs a connection to check the balance.'}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
          <Button onClick={confirm} disabled={confirmDisabled} className="flex-1">
            {loading ? 'Processing…' : online ? `Confirm ${formatGBP(total)}` : `Queue sale ${formatGBP(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
