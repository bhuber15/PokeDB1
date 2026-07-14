'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function BillingBanner() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <div className="bg-destructive/10 border-b border-destructive/30 text-sm">
      <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-2">
        <div>
          <p>Your last payment failed — please update your card to keep the shop running.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={openPortal} disabled={busy}>
          {busy ? 'Opening…' : 'Update card'}
        </Button>
      </div>
    </div>
  )
}
