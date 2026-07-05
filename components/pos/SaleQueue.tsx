'use client'
import { Button } from '@/components/ui/button'
import { formatGBP } from '@/lib/pricing'
import type { QueuedSale } from '@/lib/sale-queue'

interface SaleQueueProps {
  queue: QueuedSale[]
  onRetry: (clientUuid: string) => void
  onDiscard: (clientUuid: string) => void
}

// Shown above the cart whenever offline-queued sales exist. Pending entries
// retry automatically; conflicts wait for a human decision.
export function SaleQueue({ queue, onRetry, onDiscard }: SaleQueueProps) {
  if (queue.length === 0) return null
  const pending = queue.filter(e => !e.conflict)

  return (
    <div className="mb-4 border border-amber-400/40 bg-amber-400/5 rounded-xl overflow-hidden">
      <div className="px-3 py-2 text-sm font-semibold text-amber-500">
        {pending.length > 0
          ? `${pending.length} sale${pending.length === 1 ? '' : 's'} queued offline — retrying automatically`
          : 'Queued sales need attention'}
      </div>
      <div className="divide-y divide-border/50">
        {queue.map(e => (
          <div key={e.clientUuid} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">
                {formatGBP(e.body.expectedTotal)} · {e.body.items.reduce((s, i) => s + i.quantity, 0)} item(s) · {e.body.paymentMethod}
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(e.queuedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                {e.conflict && <span className="text-destructive font-medium ml-1.5">{e.conflict.error}</span>}
              </div>
            </div>
            {e.conflict && (
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onRetry(e.clientUuid)}>Retry</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => onDiscard(e.clientUuid)}>Discard</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
