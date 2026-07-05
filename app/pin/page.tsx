'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PinPad } from '@/components/staff/PinPad'

export default function PinPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handlePin(pin: string) {
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/staff-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (res.ok) {
      router.push('/pos')
    } else {
      setError('PIN not recognised')
      setLoading(false)
    }
  }

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
          <PinPad onSubmit={handlePin} error={error} loading={loading} />
        </div>
      </div>
    </main>
  )
}
