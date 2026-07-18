import { notFound, redirect } from 'next/navigation'
import { isMultiTenant } from '@/lib/db'
import { getAdminSession } from '@/lib/platform/admin-auth'
import { AdminLoginForm } from '@/components/admin/AdminLoginForm'

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
