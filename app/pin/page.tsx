'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PinPad } from '@/components/staff/PinPad'

export default function PinPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const router = useRouter()

  const lockRemaining = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0
  const locked = lockRemaining > 0

  useEffect(() => {
    if (!lockedUntil) return
    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= lockedUntil) {
        setLockedUntil(null)
        setError('')
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [lockedUntil])

  async function handlePin(pin: string) {
    if (locked) return
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/staff-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (res.ok) {
      router.push('/pos')
      return
    }
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      const retryAfter = Number(body?.meta?.retryAfterSeconds) || 15 * 60
      setLockedUntil(Date.now() + retryAfter * 1000)
      setNow(Date.now())
    } else {
      setError('PIN not recognised')
    }
    setLoading(false)
  }

  const mins = Math.floor(lockRemaining / 60)
  const secs = String(lockRemaining % 60).padStart(2, '0')

  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-xs space-y-8">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground text-xl font-bold shadow-lg shadow-primary/30">
            P
          </div>
          <h1 className="text-xl font-bold">Staff Sign In</h1>
          <p className="text-sm text-muted-foreground">Enter your 4-digit PIN</p>
        </div>
        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl flex flex-col items-center gap-1">
          {locked && (
            <p role="alert" className="text-sm text-destructive text-center mb-3">
              Too many failed attempts.
              <br />
              Try again in <span className="font-semibold tabular-nums">{mins}:{secs}</span>
              {' '}— or an owner login unlocks the pad.
            </p>
          )}
          <PinPad onSubmit={handlePin} error={locked ? undefined : error} loading={loading} disabled={locked} />
        </div>
      </div>
    </main>
  )
}
