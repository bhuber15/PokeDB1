import { notFound, redirect } from 'next/navigation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession } from '@/lib/platform/admin-auth'
import { AdminLoginForm } from '@/components/admin/AdminLoginForm'

// Request-time only: whether this host serves the admin surface depends on
// runtime env (TENANCY_MODE), so never bake the answer in at build time.
export const dynamic = 'force-dynamic'

export default async function AdminLoginPage() {
  if (!isMultiTenant()) notFound()
  const session = await getAdminSession()
  if (session.isPlatformAdmin) redirect('/admin')
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background">
      <h1 className="text-xl font-semibold">Platform admin</h1>
      <AdminLoginForm />
    </div>
  )
}
