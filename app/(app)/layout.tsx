import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getTenantDb } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { countInStockWants } from '@/lib/domain/wants'
import { Nav } from '@/components/layout/Nav'
import { SettingsProvider } from '@/components/shared/SettingsProvider'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session.staffId) redirect('/pin')
  const db = await getTenantDb()
  const [settings, inStockWantsCount] = await Promise.all([getSettings(db), countInStockWants(db)])
  return (
    <SettingsProvider value={settings}>
      <div className="min-h-screen bg-background">
        <Nav
          shopName={settings.shopName}
          staffName={session.staffName}
          staffRole={session.staffRole}
          inStockWantsCount={inStockWantsCount}
        />
        <main className="container mx-auto px-4 py-6">{children}</main>
      </div>
    </SettingsProvider>
  )
}
