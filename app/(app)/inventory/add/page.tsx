import Link from 'next/link'
import { AddItemForm } from '@/components/inventory/AddItemForm'
import { AddProductForm } from '@/components/inventory/AddProductForm'
import { buttonVariants } from '@/components/ui/button'

// The mode lives in the URL and the toggle is links, not client state: plain
// <a> navigations work even before React hydrates, where a useState toggle
// silently ate the shop's clicks (docs/testing/smoke-2026-07-22.md).
export default async function AddInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>
}) {
  const mode = (await searchParams).mode === 'product' ? 'product' : 'card'
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Add Inventory Item</h1>
      <div className="flex gap-2 mb-4">
        <Link href="/inventory/add" className={buttonVariants({ variant: mode === 'card' ? 'default' : 'outline' })}>Card</Link>
        <Link href="/inventory/add?mode=product" className={buttonVariants({ variant: mode === 'product' ? 'default' : 'outline' })}>Product</Link>
      </div>
      {mode === 'card' ? <AddItemForm /> : <AddProductForm />}
    </div>
  )
}
