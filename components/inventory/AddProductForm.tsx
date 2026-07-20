'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parsePounds } from '@/lib/pricing'
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, EAN_RE, type ProductCategory } from '@/lib/product-categories'

const EMPTY = { name: '', category: 'sealed' as ProductCategory, ean: '', sellPrice: '', costPrice: '', quantity: '1', lowStockThreshold: '1' }

export function AddProductForm() {
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const ean = form.ean.trim()
    if (ean && !EAN_RE.test(ean)) { toast.error('Barcode must be 8–14 digits'); return }
    const sellPrice = parsePounds(form.sellPrice)
    if (sellPrice < 1) { toast.error('Sell price is required'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          category: form.category,
          ean: ean || null,
          sellPrice,
          costPrice: form.costPrice.trim() ? parsePounds(form.costPrice) : null,
          quantity: Math.max(0, parseInt(form.quantity, 10) || 0),
          lowStockThreshold: Math.max(0, parseInt(form.lowStockThreshold, 10) || 0),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Add failed — product not saved')
        return
      }
      const { product, item } = await res.json()
      toast.success(`Added ${product.name} ×${item.quantity}`)
      setForm(EMPTY)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 max-w-md">
      <Input value={form.name} onChange={set('name')} placeholder="Product name" aria-label="Product name" required />
      <select value={form.category} onChange={set('category')} aria-label="Category"
        className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm">
        {PRODUCT_CATEGORIES.map(c => <option key={c} value={c}>{PRODUCT_CATEGORY_LABELS[c]}</option>)}
      </select>
      <Input value={form.ean} onChange={set('ean')} placeholder="Barcode (EAN) — optional" aria-label="Barcode" inputMode="numeric" />
      <div className="flex gap-2">
        <Input value={form.sellPrice} onChange={set('sellPrice')} placeholder="Sell price £" aria-label="Sell price in pounds" inputMode="decimal" required />
        <Input value={form.costPrice} onChange={set('costPrice')} placeholder="Cost £ — optional" aria-label="Cost price in pounds" inputMode="decimal" />
      </div>
      <div className="flex gap-2">
        <Input value={form.quantity} onChange={set('quantity')} placeholder="Quantity" aria-label="Quantity" inputMode="numeric" />
        <Input value={form.lowStockThreshold} onChange={set('lowStockThreshold')} placeholder="Low-stock alert at" aria-label="Low stock threshold" inputMode="numeric" />
      </div>
      <Button type="submit" disabled={saving || !form.name.trim() || !form.sellPrice.trim()}>
        {saving ? 'Saving…' : 'Add product'}
      </Button>
    </form>
  )
}
