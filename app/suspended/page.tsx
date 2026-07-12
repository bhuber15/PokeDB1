import { BRAND } from '@/lib/brand'

export default function SuspendedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">This shop is currently unavailable</h1>
        <p className="text-muted-foreground">
          The subscription for this shop isn&apos;t active. If you&apos;re the shop owner,
          check your billing details or contact {BRAND.supportEmail}.
        </p>
      </div>
    </main>
  )
}
