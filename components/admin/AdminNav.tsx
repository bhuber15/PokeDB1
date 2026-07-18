'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function AdminNav() {
  async function logout() {
    await fetch('/api/platform/admin/login', { method: 'DELETE' })
    window.location.assign('/admin/login')
  }
  return (
    <header className="border-b border-border">
      <div className="container mx-auto px-4 h-14 flex items-center gap-6">
        <span className="font-semibold">Platform admin</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/admin" className="hover:underline">Tenants</Link>
          <Link href="/admin/audit" className="hover:underline">Audit</Link>
        </nav>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={logout}>Log out</Button>
        </div>
      </div>
    </header>
  )
}
