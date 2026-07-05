'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSettings } from '@/components/shared/SettingsProvider'
import { formatGBP, parsePounds, usdToGbp as usdToGbpPence, eurToGbp as eurToGbpPence, calculateSellPrice, calculateBuyPrice } from '@/lib/pricing'

export function SettingsForm() {
  const current = useSettings()
  const router = useRouter()
  const [shopName, setShopName] = useState(String(current.shopName))
  const [usdToGbp, setUsdToGbp] = useState(String(current.usdToGbp))
  const [eurToGbp, setEurToGbp] = useState(String(current.eurToGbp))
  const [marginMultiplier, setMarginMultiplier] = useState(String(current.marginMultiplier))
  // Threshold is stored in pence; the input is edited in pounds
  const [highValueThreshold, setHighValueThreshold] = useState(String(current.highValueThreshold / 100))
  const [buyCashPct, setBuyCashPct] = useState(String(current.buyCashPct))
  const [buyCreditPct, setBuyCreditPct] = useState(String(current.buyCreditPct))
  const [primaryPriceSource, setPrimaryPriceSource] = useState<'cardmarket' | 'tcgplayer'>(current.primaryPriceSource)
  const [vatScheme, setVatScheme] = useState<'none' | 'standard'>(current.vatScheme)
  const [saving, setSaving] = useState(false)

  const rate = parseFloat(usdToGbp) || 0
  const eurRate = parseFloat(eurToGbp) || 0
  const margin = parseFloat(marginMultiplier) || 0
  // Worked examples use the real pricing functions so they match actual behavior (all pence)
  const exampleGbp = usdToGbpPence(10, rate) // a $10 TCGplayer card
  const exampleSell = calculateSellPrice(exampleGbp, null, margin)
  const exampleCmGbp = eurToGbpPence(10, eurRate) // a €10 Cardmarket card
  const exampleCmSell = calculateSellPrice(exampleCmGbp, null, margin)
  const TEN_POUNDS = 1000 // pence, for the buylist example
  const cashExample = calculateBuyPrice(TEN_POUNDS, parseFloat(buyCashPct) || 0)
  const creditExample = calculateBuyPrice(TEN_POUNDS, parseFloat(buyCreditPct) || 0)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopName,
          usdToGbp: parseFloat(usdToGbp),
          eurToGbp: parseFloat(eurToGbp),
          marginMultiplier: parseFloat(marginMultiplier),
          highValueThreshold: parsePounds(highValueThreshold), // API speaks pence
          buyCashPct: parseFloat(buyCashPct),
          buyCreditPct: parseFloat(buyCreditPct),
          primaryPriceSource,
          vatScheme,
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
          <Label htmlFor="settings-shop-name">Shop name</Label>
          <Input id="settings-shop-name" name="shopName" value={shopName} onChange={e => setShopName(e.target.value)} maxLength={60} />
          <p className="text-xs text-muted-foreground">Shown in the top bar and on the login screen.</p>
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Pricing</h2>

        <div className="space-y-1.5">
          <Label htmlFor="settings-usd-gbp">USD → GBP rate</Label>
          <Input id="settings-usd-gbp" name="usdToGbp" type="number" inputMode="decimal" step="0.01" min={0} value={usdToGbp} onChange={e => setUsdToGbp(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            TCG prices are in US dollars. This converts them to £. Update it when the exchange rate moves.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-eur-gbp">EUR → GBP rate</Label>
          <Input id="settings-eur-gbp" name="eurToGbp" type="number" inputMode="decimal" step="0.01" min={0} value={eurToGbp} onChange={e => setEurToGbp(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Cardmarket prices are in Euros. This converts them to £. Update it when the exchange rate moves.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Sell price source</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPrimaryPriceSource('cardmarket')}
              className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                primaryPriceSource === 'cardmarket'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-muted'
              }`}
            >
              Cardmarket
            </button>
            <button
              type="button"
              onClick={() => setPrimaryPriceSource('tcgplayer')}
              className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                primaryPriceSource === 'tcgplayer'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-muted'
              }`}
            >
              TCGplayer
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Which market price drives sell-price calculations in POS and Inventory.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>VAT scheme</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setVatScheme('none')}
              className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                vatScheme === 'none'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-muted'
              }`}
            >
              Not registered
            </button>
            <button
              type="button"
              onClick={() => setVatScheme('standard')}
              className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                vatScheme === 'standard'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:bg-muted'
              }`}
            >
              Standard VAT
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Applied to sales at checkout. Switch to Standard when the shop registers for VAT.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-margin">Margin multiplier</Label>
          <Input id="settings-margin" name="marginMultiplier" type="number" inputMode="decimal" step="0.01" min={0} value={marginMultiplier} onChange={e => setMarginMultiplier(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Sell price = market price × this. e.g. 0.85 = sell at 85% of market.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-high-value">High-value threshold (£)</Label>
          <Input id="settings-high-value" name="highValueThreshold" type="number" inputMode="decimal" step="1" min={0} value={highValueThreshold} onChange={e => setHighValueThreshold(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Cards at or above this market value get a ⚠ warning for stale prices.
          </p>
        </div>

        {/* Live worked example */}
        <div className="bg-muted/30 rounded-lg p-3 text-sm space-y-2">
          <div className="text-xs text-muted-foreground mb-1">Worked example — a $10 TCGplayer card / €10 Cardmarket card:</div>
          <div className="flex justify-between"><span className="text-muted-foreground">TCGplayer market in £</span><span className="font-medium">{formatGBP(exampleGbp)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Cardmarket market in £</span><span className="font-medium">{formatGBP(exampleCmGbp)}</span></div>
          <div className="flex justify-between border-t border-border/40 pt-1.5">
            <span className="text-muted-foreground">Auto sell price ({primaryPriceSource === 'cardmarket' ? 'CM' : 'TCG'})</span>
            <span className="font-bold text-primary">{formatGBP(primaryPriceSource === 'cardmarket' ? exampleCmSell : exampleSell)}</span>
          </div>
        </div>
      </section>

      {/* Buy percentages */}
      <section className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Buylist Rates</h2>
        <p className="text-xs text-muted-foreground">
          Enter as a decimal fraction (0–1). e.g. 0.5 = 50% of a card&apos;s sell price.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="settings-buy-cash">Cash buy % (0–1)</Label>
          <Input id="settings-buy-cash" name="buyCashPct" type="number" inputMode="decimal" step="0.01" min={0} max={1} value={buyCashPct} onChange={e => setBuyCashPct(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Fraction of sell price paid in cash. e.g. 0.5 = pay 50% of market.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-buy-credit">Credit buy % (0–1)</Label>
          <Input id="settings-buy-credit" name="buyCreditPct" type="number" inputMode="decimal" step="0.01" min={0} max={1} value={buyCreditPct} onChange={e => setBuyCreditPct(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Fraction of sell price paid as store credit. Usually higher than cash.
          </p>
        </div>

        {/* Live worked example */}
        <div className="bg-muted/30 rounded-lg p-3 text-sm">
          <div className="text-xs text-muted-foreground mb-1">Worked example — a £10 card:</div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pay in cash</span><span className="font-medium">{formatGBP(cashExample)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Pay in credit</span><span className="font-bold text-primary">{formatGBP(creditExample)}</span></div>
        </div>
      </section>

      <Button className="w-full h-10" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  )
}
