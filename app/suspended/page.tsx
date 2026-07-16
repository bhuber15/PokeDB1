import { BRAND } from '@/lib/brand'

export default async function SuspendedPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams
  const paused = reason === 'paused'
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">
          {paused ? "This shop's free trial has ended" : 'This shop is currently unavailable'}
        </h1>
        <p className="text-muted-foreground">
          {paused
            ? `Your data is safe. If you're the shop owner, email ${BRAND.supportEmail} to add a payment method and pick up where you left off.`
            : `The subscription for this shop isn't active. If you're the shop owner, check your billing details or contact ${BRAND.supportEmail}.`}
        </p>
      </div>
    </main>
  )
}
