'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function SetupForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [staffName, setStaffName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Passwords do not match'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, staffName, pin }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong')
      window.location.href = '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">Shop password</Label>
        <Input id="password" type="password" value={password} required minLength={8}
          onChange={(e) => setPassword(e.target.value)} />
        <p className="text-xs text-muted-foreground">Unlocks the till each morning. At least 8 characters.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" type="password" value={confirm} required onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="staffName">Your name</Label>
        <Input id="staffName" value={staffName} required onChange={(e) => setStaffName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pin">Your admin PIN (4 digits)</Label>
        <Input id="pin" inputMode="numeric" pattern="\d{4}" maxLength={4} value={pin} required
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <p className="text-xs text-muted-foreground">Staff use PINs to switch user at the till.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Setting up…' : 'Finish setup'}
      </Button>
    </form>
  )
}
