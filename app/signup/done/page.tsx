import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'

export const metadata = { title: 'Check your email' }

export default function SignupDonePage() {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-2xl font-semibold">You&apos;re in — check your email</h1>
        <p className="text-muted-foreground">
          We&apos;re setting up your shop now (it takes about a minute). Your welcome email
          contains the link to set your password and get started.
        </p>
        <p className="text-muted-foreground text-sm">
          Nothing arrived after a few minutes? Check spam, or email {BRAND.supportEmail}.
        </p>
      </div>
    </main>
  )
}
