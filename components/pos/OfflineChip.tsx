'use client'
import { WifiOffIcon } from 'lucide-react'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'

// Shown in the POS header while the browser is offline. Purely informative:
// checkout still works offline via the sale queue (lib/sale-queue.ts); this
// chip just makes that state visible to staff. POS-only on purpose — other
// pages have no offline queue, so a global chip would overpromise.
export function OfflineChip() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 h-12 px-3 rounded-xl border border-amber-400/40 bg-amber-400/5 text-amber-500 text-xs font-medium shrink-0"
    >
      <WifiOffIcon className="size-3.5" aria-hidden="true" />
      Offline — sales will queue
    </div>
  )
}
