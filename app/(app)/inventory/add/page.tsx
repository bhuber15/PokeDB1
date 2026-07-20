'use client'
import { useState } from 'react'
import { AddItemForm } from '@/components/inventory/AddItemForm'
import { AddProductForm } from '@/components/inventory/AddProductForm'
import { Button } from '@/components/ui/button'

export default function AddInventoryPage() {
  const [mode, setMode] = useState<'card' | 'product'>('card')
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Add Inventory Item</h1>
      <div className="flex gap-2 mb-4">
        <Button variant={mode === 'card' ? 'default' : 'outline'} onClick={() => setMode('card')}>Card</Button>
        <Button variant={mode === 'product' ? 'default' : 'outline'} onClick={() => setMode('product')}>Product</Button>
      </div>
      {mode === 'card' ? <AddItemForm /> : <AddProductForm />}
    </div>
  )
}
