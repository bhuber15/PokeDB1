'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PinPad } from '@/components/staff/PinPad'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-xl">Enter Staff PIN</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center pb-6">
          <PinPad onSubmit={handlePin} error={error} loading={loading} />
        </CardContent>
      </Card>
    </div>
  )
}
