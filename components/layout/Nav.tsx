'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface NavProps {
  staffName?: string
  staffRole?: string
}

export function Nav({ staffName, staffRole }: NavProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function lock() {
    await fetch('/api/auth/staff-pin', { method: 'DELETE' })
    router.push('/pin')
  }

  const links = [
    { href: '/pos', label: 'POS' },
    { href: '/inventory', label: 'Inventory' },
    ...(staffRole === 'admin' ? [{ href: '/reports', label: 'Reports' }] : []),
  ]

  return (
    <nav className="border-b px-4 py-3 flex items-center justify-between bg-background">
      <div className="flex items-center gap-5">
        <span className="font-bold text-lg tracking-tight">PokeDB</span>
        <div className="flex gap-1">
          {links.map(l => (
            <Link key={l.href} href={l.href}>
              <Button variant={pathname.startsWith(l.href) ? 'default' : 'ghost'} size="sm">
                {l.label}
              </Button>
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {staffName && (
          <span className="text-sm text-muted-foreground">
            {staffName} <Badge variant="outline" className="ml-1">{staffRole}</Badge>
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={lock}>Lock</Button>
      </div>
    </nav>
  )
}
