import { notFound } from 'next/navigation'
import { BRAND } from '@/lib/brand'
import { SetupForm } from '@/components/platform/SetupForm'

export const metadata = { title: 'Set up your shop' }

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (process.env.TENANCY_MODE !== 'multi') notFound()
  const { token } = await searchParams
  if (!token) notFound()
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Welcome to {BRAND.name}</h1>
          <p className="text-muted-foreground">Set your shop password and your PIN — then you&apos;re in.</p>
        </div>
        <SetupForm token={token} />
      </div>
    </main>
  )
}
