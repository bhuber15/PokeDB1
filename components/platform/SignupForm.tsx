'use client'

import { useState } from 'react'
import { PLANS, PLAN_IDS, type Plan } from '@/lib/plan'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function suggestSlug(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function SignupForm() {
  const [shopName, setShopName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState<Plan>('growth')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/platform/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shopName, slug, email, plan }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong')
      window.location.href = body.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {PLAN_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setPlan(id)}
            aria-pressed={plan === id}
            className={`rounded-lg border p-3 text-left ${plan === id ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
          >
            <div className="font-medium">{PLANS[id].label}</div>
            <div className="text-sm text-muted-foreground">£{PLANS[id].pricePence / 100}/month</div>
            <div className="text-xs text-muted-foreground">
              {PLANS[id].entitlements.staffSeats === null ? 'Unlimited staff' : `${PLANS[id].entitlements.staffSeats} staff seats`}
            </div>
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="shopName">Shop name</Label>
        <Input id="shopName" value={shopName} required minLength={2} maxLength={60}
          onChange={(e) => { setShopName(e.target.value); if (!slugEdited) setSlug(suggestSlug(e.target.value)) }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Your shop address</Label>
        <div className="flex items-center gap-1">
          <Input id="slug" value={slug} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
            onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()) }} />
          <span className="text-sm text-muted-foreground whitespace-nowrap">.{process.env.NEXT_PUBLIC_BRAND_BASE_HOST || 'yourshop.example'}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Your email</Label>
        <Input id="email" type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Redirecting…' : 'Start free trial'}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        You&apos;ll confirm your details with our payment provider — no card is taken for the trial.
      </p>
    </form>
  )
}
