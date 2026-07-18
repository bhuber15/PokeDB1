import { notFound, redirect } from 'next/navigation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession } from '@/lib/platform/admin-auth'
import { AdminNav } from '@/components/admin/AdminNav'

// Live ops data on every render — never prerender these at build time
// (the registry isn't reachable there, and stale tenant lists are useless).
export const dynamic = 'force-dynamic'

// Defence in depth: the proxy already gates the admin host, but these pages
// re-check the session and 404 outright in single-tenant mode.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!isMultiTenant()) notFound()
  const session = await getAdminSession()
  if (!session.isPlatformAdmin) redirect('/admin/login')
  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <main className="container mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
