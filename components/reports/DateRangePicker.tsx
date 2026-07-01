'use client'
import { Button } from '@/components/ui/button'

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function preset(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - days)
  return { from: toISODate(from), to: toISODate(to) }
}

function thisMonth(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  return { from: toISODate(from), to: toISODate(now) }
}

interface Props {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
}

export function DateRangePicker({ from, to, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={from}
        max={to}
        onChange={e => onChange({ from: e.target.value, to })}
        className="border rounded px-2 py-1 text-sm"
      />
      <span className="text-muted-foreground text-sm">to</span>
      <input
        type="date"
        value={to}
        min={from}
        onChange={e => onChange({ from, to: e.target.value })}
        className="border rounded px-2 py-1 text-sm"
      />
      <div className="flex gap-1 ml-2">
        <Button size="sm" variant="outline" onClick={() => onChange(preset(0))}>Today</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(preset(7))}>7 days</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(preset(30))}>30 days</Button>
        <Button size="sm" variant="outline" onClick={() => onChange(thisMonth())}>This month</Button>
      </div>
    </div>
  )
}
