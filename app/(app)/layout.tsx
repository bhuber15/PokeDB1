import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { Nav } from '@/components/layout/Nav'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session.staffId) redirect('/pin')
  return (
    <div className="min-h-screen bg-background">
      <Nav staffName={session.staffName} staffRole={session.staffRole} />
      <main className="container mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
