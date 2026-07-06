'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginForm({ shopName }: { shopName: string }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push('/pin')
    } else if (res.status === 429) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Too many failed attempts. Try again later.')
      setLoading(false)
    } else {
      setError('Incorrect password')
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground text-3xl font-bold shadow-lg shadow-primary/30">
            {shopName[0]?.toUpperCase() ?? 'P'}
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{shopName}</h1>
            <p className="text-sm text-muted-foreground mt-1">Collectible Card Shop POS</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Owner Access</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoFocus
                placeholder="Enter owner password"
                className="h-10"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full h-10" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in →'}
            </Button>
          </form>
        </div>
      </div>
    </main>
  )
}
