'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function BillingBanner() {
  const [busy, setBusy] = useState(false)

  async function openPortal() {
    setBusy(true)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const body = await res.json()
      if (res.ok && body.url) window.location.href = body.url
      else setBusy(false)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="bg-destructive/10 border-b border-destructive/30 text-sm">
      <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-2">
        <p>Your last payment failed — please update your card to keep the shop running.</p>
        <Button size="sm" variant="outline" onClick={openPortal} disabled={busy}>
          {busy ? 'Opening…' : 'Update card'}
        </Button>
      </div>
    </div>
  )
}
