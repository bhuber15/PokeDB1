'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSettings } from '@/components/shared/SettingsProvider'
import { formatGBP } from '@/lib/pricing'

export function SettingsForm() {
  const current = useSettings()
  const router = useRouter()
  const [shopName, setShopName] = useState(String(current.shopName))
  const [usdToGbp, setUsdToGbp] = useState(String(current.usdToGbp))
  const [marginMultiplier, setMarginMultiplier] = useState(String(current.marginMultiplier))
  const [highValueThreshold, setHighValueThreshold] = useState(String(current.highValueThreshold))
  const [saving, setSaving] = useState(false)

  const rate = parseFloat(usdToGbp) || 0
  const margin = parseFloat(marginMultiplier) || 0
  // Worked example: a $10 USD card
  const exampleGbp = 10 * rate
  const exampleSell = exampleGbp * margin

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopName,
          usdToGbp: parseFloat(usdToGbp),
          marginMultiplier: parseFloat(marginMultiplier),
          highValueThreshold: parseFloat(highValueThreshold),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not save settings')
        return
      }
      toast.success('Settings saved')
      router.refresh() // re-reads settings in the server layout → updates everywhere
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Shop branding and pricing rules</p>
      </div>

      {/* Branding */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Branding</h2>
        <div className="space-y-1.5">
          <Label>Shop name</Label>
          <Input value={shopName} onChange={e => setShopName(e.target.value)} maxLength={60} />
          <p className="text-xs text-muted-foreground">Shown in the top bar and on the login screen.</p>
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Pricing</h2>

        <div className="space-y-1.5">
          <Label>USD → GBP rate</Label>
          <Input type="number" step="0.01" min={0} value={usdToGbp} onChange={e => setUsdToGbp(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            TCG prices are in US dollars. This converts them to £. Update it when the exchange rate moves.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Margin multiplier</Label>
          <Input type="number" step="0.01" min={0} value={marginMultiplier} onChange={e => setMarginMultiplier(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Sell price = market price × this. e.g. 0.85 = sell at 85% of market.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>High-value threshold (£)</Label>
          <Input type="number" step="1" min={0} value={highValueThreshold} onChange={e => setHighValueThreshold(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Cards at or above this market value get a ⚠ warning for stale prices.
          </p>
        </div>

        {/* Live worked example */}
        <div className="bg-muted/30 rounded-lg p-3 text-sm">
          <div className="text-xs text-muted-foreground mb-1">Worked example — a $10 USD card:</div>
          <div className="flex justify-between"><span className="text-muted-foreground">Market in £</span><span className="font-medium">{formatGBP(exampleGbp)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Auto sell price</span><span className="font-bold text-primary">{formatGBP(exampleSell)}</span></div>
        </div>
      </section>

      <Button className="w-full h-10" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  )
}
