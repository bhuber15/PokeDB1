'use client'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatGBP, parsePounds } from '@/lib/pricing'
import type { CashUpRecord } from '@/lib/domain/cash-ups'
import type { CashUpSummary } from '@/lib/domain/reports'

interface CashUpData {
  summary: CashUpSummary
  close: CashUpRecord | null
  recent: CashUpRecord[]
}

function VarianceBadge({ variance }: { variance: number }) {
  if (variance === 0) return <Badge variant="outline">Balanced</Badge>
  return variance < 0
    ? <Badge variant="destructive">Short {formatGBP(-variance)}</Badge>
    : <Badge variant="secondary">Over {formatGBP(variance)}</Badge>
}

// Expected drawer = float + cash sales − cash refunds − cash buylist payouts.
// Closing snapshots that computation into cash_ups; a closed day renders the
// stored record instead of the live recomputation.
export function CashUpSection() {
  const todayISO = new Date().toISOString().slice(0, 10)
  const [day, setDay] = useState(todayISO)
  const [data, setData] = useState<CashUpData | null>(null)
  const [float, setFloat] = useState('')
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/reports/cash-up?day=${day}`)
      .then(async res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }, [day])

  useEffect(load, [load])

  if (!data) return null
  const { summary, close, recent } = data

  const floatPence = parsePounds(float || '0')
  const countedPence = parsePounds(counted || '0')
  const expected = floatPence + summary.cashSales - summary.cashRefunds - summary.cashBuyPayouts
  const liveVariance = countedPence - expected

  async function submitClose() {
    setSubmitting(true)
    try {
      const res = await fetch('/api/reports/cash-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day,
          openingFloat: floatPence,
          countedCash: countedPence,
          notes: notes.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(body?.error ?? 'Failed to close day')
        return
      }
      toast.success(`Day closed — ${day}`)
      setFloat(''); setCounted(''); setNotes('')
      load()
    } catch {
      toast.error('Network error — day not closed')
    } finally {
      setSubmitting(false)
    }
  }

  const movements = (
    <>
      <div className="flex justify-between"><span className="text-muted-foreground">+ Cash sales</span><span className="tabular-nums">{formatGBP(close?.cashSales ?? summary.cashSales)}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">− Cash refunds</span><span className="tabular-nums">{(close?.cashRefunds ?? summary.cashRefunds) > 0 ? `−${formatGBP(close?.cashRefunds ?? summary.cashRefunds)}` : formatGBP(0)}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">− Cash buylist payouts</span><span className="tabular-nums">{(close?.cashBuyPayouts ?? summary.cashBuyPayouts) > 0 ? `−${formatGBP(close?.cashBuyPayouts ?? summary.cashBuyPayouts)}` : formatGBP(0)}</span></div>
    </>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Cash Up</h2>
        <Input
          type="date"
          value={day}
          max={todayISO}
          onChange={e => e.target.value && setDay(e.target.value)}
          className="w-40 h-8"
          aria-label="Cash-up day"
        />
      </div>

      {close ? (
        <Card>
          <CardContent className="pt-6 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">Closed by {close.staffName ?? 'Unknown'}</span>
              <VarianceBadge variance={close.variance} />
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">Opening float</span><span className="tabular-nums">{formatGBP(close.openingFloat)}</span></div>
            {movements}
            <div className="flex justify-between border-t pt-2 mt-2"><span className="text-muted-foreground">Expected in drawer</span><span className="tabular-nums">{formatGBP(close.expectedCash)}</span></div>
            <div className="flex justify-between font-bold text-base"><span>Counted</span><span className="tabular-nums">{formatGBP(close.countedCash)}</span></div>
            {close.notes && <p className="text-muted-foreground border-t pt-2 mt-2 whitespace-pre-wrap">{close.notes}</p>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="cash-up-float" className="text-muted-foreground font-normal">Opening float (£)</Label>
              <Input
                id="cash-up-float"
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={float}
                onChange={e => setFloat(e.target.value)}
                placeholder="0.00"
                className="w-28 h-8 text-right"
              />
            </div>
            {movements}
            <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
              <span>Expected in drawer</span><span className="tabular-nums">{formatGBP(expected)}</span>
            </div>
            <div className="flex items-center justify-between gap-4 pt-2">
              <Label htmlFor="cash-up-counted" className="text-muted-foreground font-normal">Counted cash (£)</Label>
              <Input
                id="cash-up-counted"
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={counted}
                onChange={e => setCounted(e.target.value)}
                placeholder="0.00"
                className="w-28 h-8 text-right"
              />
            </div>
            {counted !== '' && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Variance</span>
                <VarianceBadge variance={liveVariance} />
              </div>
            )}
            <div className="space-y-1 pt-2">
              <Label htmlFor="cash-up-notes" className="text-muted-foreground font-normal">Notes</Label>
              <Input
                id="cash-up-notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. reason for over/short"
                maxLength={500}
              />
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={submitClose} disabled={submitting || counted === ''}>
                {submitting ? 'Closing…' : 'Close day'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {recent.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                {['Day', 'Expected', 'Counted', 'Variance'].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide last:text-right">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {recent.map(c => (
                <tr key={c.id}>
                  <td className="px-3 py-2 tabular-nums">{c.day}</td>
                  <td className="px-3 py-2 tabular-nums">{formatGBP(c.expectedCash)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatGBP(c.countedCash)}</td>
                  <td className="px-3 py-2 text-right"><VarianceBadge variance={c.variance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
