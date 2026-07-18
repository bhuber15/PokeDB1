'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function ImpersonateButton({ tenantId }: { tenantId: number }) {
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    const res = await fetch('/api/platform/admin/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    })
    if (res.ok) {
      const { url } = await res.json()
      window.location.assign(url)   // shop host burns the one-time grant
      return
    }
    setBusy(false)
  }
  return (
    <Button variant="outline" size="sm" onClick={go} disabled={busy}>
      {busy ? 'Opening…' : 'Open shop'}
    </Button>
  )
}
