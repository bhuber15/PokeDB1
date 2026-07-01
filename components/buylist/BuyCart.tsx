'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CustomerPicker } from '@/components/shared/CustomerPicker'
import { formatGBP } from '@/lib/pricing'
import { toast } from 'sonner'
import type { Customer } from '@/lib/db/schema'
import type { BuyLineInput } from './BuyCard'

export interface BuyCartLine extends BuyLineInput {
  cardName: string
}

type PayMethod = 'cash' | 'store_credit'

interface BuyCartProps {
  lines: BuyCartLine[]
  onRemove: (idx: number) => void
  onClear: () => void
}

export function BuyCart({ lines, onRemove, onClear }: BuyCartProps) {
  const [method, setMethod] = useState<PayMethod>('cash')
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [confirming, setConfirming] = useState(false)

  const total = lines.reduce((sum, l) => {
    const price = method === 'cash' ? l.payPriceCash : l.payPriceCredit
    return sum + (price ?? 0) * l.quantity
  }, 0)

  const creditRequiresCustomer = method === 'store_credit' && !customer
  const canConfirm = lines.length > 0 && !creditRequiresCustomer

  async function handleConfirm() {
    setConfirming(true)
    try {
      const res = await fetch('/api/buys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: lines.map(l => ({
            cardId: l.cardId,
            condition: l.condition,
            quantity: l.quantity,
            payPrice: method === 'cash' ? (l.payPriceCash ?? 0) : (l.payPriceCredit ?? 0),
          })),
          method,
          customerId: customer?.id ?? undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Buy failed — please try again')
        return
      }
      const { total: confirmedTotal } = await res.json()
      const cardCount = lines.reduce((n, l) => n + l.quantity, 0)
      toast.success(`Bought ${cardCount} card${cardCount !== 1 ? 's' : ''} for ${formatGBP(confirmedTotal)}`)
      onClear()
      setCustomer(null)
    } finally {
      setConfirming(false)
    }
  }

  if (lines.length === 0) {
    return (
      <div className="border rounded-xl p-8 text-center text-muted-foreground text-sm space-y-1">
        <div>Buy cart is empty</div>
        <div className="text-xs">Search a card and add it to start buying</div>
      </div>
    )
  }

  return (
    <div className="border rounded-xl overflow-hidden flex flex-col">
      {/* Method toggle */}
      <div className="flex border-b">
        {(['cash', 'store_credit'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              method === m
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground'
            }`}
          >
            {m === 'cash' ? 'Cash' : 'Store Credit'}
          </button>
        ))}
      </div>

      {/* Lines */}
      <div className="divide-y flex-1">
        {lines.map((line, idx) => {
          const price = method === 'cash' ? line.payPriceCash : line.payPriceCredit
          return (
            <div key={idx} className="flex items-center gap-3 p-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{line.cardName}</div>
                <div className="text-sm text-muted-foreground flex gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs py-0">{line.condition}</Badge>
                  <span>× {line.quantity}</span>
                  <span>@ {formatGBP(price)} each</span>
                </div>
              </div>
              <div className="font-semibold shrink-0">
                {formatGBP(price != null ? price * line.quantity : null)}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(idx)}
              >
                ✕
              </Button>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="p-4 border-t bg-muted/20 space-y-3">
        {/* Customer picker (always shown so you can set in advance) */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">
            Customer {method === 'store_credit' && <span className="text-destructive">*required</span>}
          </div>
          <CustomerPicker
            selected={customer}
            onSelect={(c: Customer | null) => setCustomer(c)}
          />
        </div>

        {/* Total */}
        <div className="flex justify-between items-center">
          <span className="font-semibold">Total to pay</span>
          <span className="text-xl font-bold">{formatGBP(total)}</span>
        </div>

        {creditRequiresCustomer && (
          <p className="text-xs text-destructive">Select a customer to pay with store credit</p>
        )}

        <Button
          className="w-full h-11 text-base"
          onClick={handleConfirm}
          disabled={!canConfirm || confirming}
        >
          {confirming ? 'Confirming…' : `Confirm buy (${method === 'cash' ? 'Cash' : 'Credit'})`}
        </Button>
      </div>
    </div>
  )
}
