import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'
import { SignupForm } from '@/components/platform/SignupForm'

export const metadata = { title: `Start your free trial` }

export default function SignupPage() {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Start your {BRAND.name} trial</h1>
          <p className="text-muted-foreground">14 days free. No card needed. Cancel any time.</p>
        </div>
        <SignupForm />
      </div>
    </main>
  )
}
