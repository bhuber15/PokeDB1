'use client'
import { WifiOffIcon } from 'lucide-react'
import { useOnlineStatus } from '@/components/shared/useOnlineStatus'

// App-wide honesty bar for outages. States exactly what degrades: POS sales
// queue locally and replay (lib/sale-queue.ts); everything that needs the
// server — search, buys, refunds — waits. The POS keeps its local OfflineChip
// as the at-a-glance till indicator; this banner is the detailed version.
export function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-400/40 text-amber-600 dark:text-amber-400 text-sm font-medium"
    >
      <WifiOffIcon className="size-4 shrink-0" aria-hidden="true" />
      Offline — sales will queue and send when the connection returns. Search, buys and refunds need a connection.
    </div>
  )
}
