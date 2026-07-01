import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center bg-background">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-muted-foreground max-w-sm">The page you&rsquo;re looking for doesn&rsquo;t exist.</p>
      <Link href="/pos" className={buttonVariants()}>Back to POS</Link>
    </div>
  )
}
