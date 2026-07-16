'use client'

import { useEffect, useState } from 'react'
import { PLANS, isPlan } from '@/lib/plan'
import { formatGBP } from '@/lib/pricing'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface Billing {
  managed: boolean
  plan?: string
  status?: string
  trialEndsAt?: number | null
  cancelAtPeriodEnd?: boolean
}

const STATUS_COPY: Record<string, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment overdue',
  paused: 'Paused',
}

export function BillingCard() {
  const [billing, setBilling] = useState<Billing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/billing').then(r => (r.ok ? r.json() : null)).then(setBilling).catch(() => setBilling(null))
  }, [])

  if (!billing?.managed) return null
  const planLabel = isPlan(billing.plan) ? `${PLANS[billing.plan].label} — ${formatGBP(PLANS[billing.plan].pricePence)}/month` : billing.plan
  const daysLeft = billing.trialEndsAt
    // eslint-disable-next-line react-hooks/purity -- trial countdown; a fresh clock reading each render is intended
    ? Math.max(0, Math.ceil((billing.trialEndsAt * 1000 - Date.now()) / 86_400_000))
    : null

  async function openPortal() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const body = await res.json()
      if (res.ok && body.url) {
        window.location.href = body.url
      } else {
        setError("Couldn't open billing — please try again, or email support.")
        setBusy(false)
      }
    } catch {
      setError("Couldn't open billing — please try again, or email support.")
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Billing</h2>
        <Badge variant={billing.status === 'past_due' ? 'destructive' : 'secondary'}>
          {STATUS_COPY[billing.status ?? ''] ?? billing.status}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{planLabel}</p>
      {billing.status === 'trialing' && daysLeft !== null && (
        <p className="text-sm text-muted-foreground">
          {daysLeft} day{daysLeft === 1 ? '' : 's'} left in your trial — add a card to keep trading after it ends.
        </p>
      )}
      {billing.cancelAtPeriodEnd && (
        <p className="text-sm text-muted-foreground">Your subscription is set to cancel at the end of the period.</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button onClick={openPortal} disabled={busy} variant="outline">
        {busy ? 'Opening…' : 'Manage billing'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Change plan, update your card, download invoices or cancel — handled securely by Stripe.
      </p>
    </div>
  )
}
