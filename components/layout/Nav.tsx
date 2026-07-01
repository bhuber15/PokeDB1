'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface NavProps {
  shopName?: string
  staffName?: string
  staffRole?: string
}

export function Nav({ shopName = 'PokeDB', staffName, staffRole }: NavProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function lock() {
    await fetch('/api/auth/staff-pin', { method: 'DELETE' })
    router.push('/pin')
  }

  const links = [
    { href: '/pos', label: '🛒 POS' },
    { href: '/buylist', label: '💰 Buy' },
    { href: '/customers', label: '👤 Customers' },
    { href: '/inventory', label: '📦 Inventory' },
    { href: '/prices', label: '🔍 Prices' },
    ...(staffRole === 'admin' ? [
      { href: '/reports', label: '📊 Reports' },
      { href: '/settings', label: '⚙️ Settings' },
    ] : []),
  ]

  return (
    <nav className="border-b border-border/60 px-5 flex items-center justify-between bg-card/80 backdrop-blur-sm sticky top-0 z-50 h-14">
      <div className="flex items-center gap-6">
        <Link href="/pos" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
            {shopName[0]?.toUpperCase() ?? 'P'}
          </div>
          <span className="font-bold text-base tracking-tight">{shopName}</span>
        </Link>
        <div className="flex">
          {links.map(l => {
            const active = pathname.startsWith(l.href)
            return (
              <Link key={l.href} href={l.href}>
                <button className={`px-4 h-14 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                  {l.label}
                </button>
              </Link>
            )
          })}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {staffName && (
          <div className="flex items-center gap-2 text-sm">
            <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-primary font-semibold text-xs">
              {staffName[0].toUpperCase()}
            </div>
            <span className="font-medium hidden sm:block">{staffName}</span>
            <Badge variant="outline" className="text-xs border-primary/30 text-primary hidden sm:flex">{staffRole}</Badge>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={lock} className="text-muted-foreground hover:text-foreground text-xs">
          🔒 Lock
        </Button>
      </div>
    </nav>
  )
}
