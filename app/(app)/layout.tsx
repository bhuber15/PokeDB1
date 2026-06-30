import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { Nav } from '@/components/layout/Nav'
import { SettingsProvider } from '@/components/shared/SettingsProvider'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session.staffId) redirect('/pin')
  const settings = await getSettings()
  return (
    <SettingsProvider value={settings}>
      <div className="min-h-screen bg-background">
        <Nav shopName={settings.shopName} staffName={session.staffName} staffRole={session.staffRole} />
        <main className="container mx-auto px-4 py-6">{children}</main>
      </div>
    </SettingsProvider>
  )
}
