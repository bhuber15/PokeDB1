import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { CheckoutDialog, type CheckoutConfirmOptions } from './CheckoutDialog'
import type { CartItem } from './Cart'
import type { Customer } from '@/lib/db/schema'

afterEach(cleanup)

const dave = { id: 1, name: 'Dave', phone: null, email: null } as unknown as Customer

const items: CartItem[] = [
  { inventoryItemId: 1, name: 'Charizard', condition: 'NM', price: 850, quantity: 1 },
]

// Both the dialog and the CustomerPicker fetch /api/customers/1 for the balance.
function mockBalance(balance: number) {
  global.fetch = (async () => ({ ok: true, json: async () => ({ balance }) })) as unknown as typeof fetch
}

function renderDialog(onConfirm: (opts: CheckoutConfirmOptions) => Promise<void>) {
  return render(
    <CheckoutDialog open items={items} onClose={() => {}} onConfirm={onConfirm} initialCustomer={dave} />,
  )
}

test('trade-in handoff: preselects the customer and applies partial credit as a split', async () => {
  mockBalance(650)
  let confirmed: CheckoutConfirmOptions | null = null
  renderDialog(async opts => { confirmed = opts })

  // initialCustomer is applied on open and their balance fetched
  await screen.findByText('Dave')
  const apply = await screen.findByRole('button', { name: /apply store credit/i })
  assert.match(apply.textContent ?? '', /£6\.50/)
  assert.match(apply.textContent ?? '', /rest by card/)

  // One tap builds the split: credit £6.50 + card £2.00, fully allocated
  fireEvent.click(apply)
  await screen.findByText('Fully allocated')
  assert.equal((screen.getByLabelText('Payment method 1') as HTMLSelectElement).value, 'store_credit')
  assert.equal((screen.getByLabelText('Amount 1 (£)') as HTMLInputElement).value, '6.50')
  assert.equal((screen.getByLabelText('Payment method 2') as HTMLSelectElement).value, 'card')
  assert.equal((screen.getByLabelText('Amount 2 (£)') as HTMLInputElement).value, '2.00')

  fireEvent.click(screen.getByRole('button', { name: /confirm £8\.50/i }))
  await waitFor(() => assert.ok(confirmed))
  assert.deepEqual(confirmed!.payments, [
    { method: 'store_credit', amount: 650 },
    { method: 'card', amount: 200 },
  ])
  assert.equal(confirmed!.customerId, 1)
  assert.equal(confirmed!.expectedTotal, 850)
})

test('apply store credit covers the whole total as a plain store-credit tender', async () => {
  mockBalance(2000)
  let confirmed: CheckoutConfirmOptions | null = null
  renderDialog(async opts => { confirmed = opts })

  const apply = await screen.findByRole('button', { name: /apply store credit/i })
  assert.match(apply.textContent ?? '', /£8\.50/) // capped at the total, not the balance
  assert.doesNotMatch(apply.textContent ?? '', /rest by card/)

  fireEvent.click(apply)
  fireEvent.click(screen.getByRole('button', { name: /confirm £8\.50/i }))
  await waitFor(() => assert.ok(confirmed))
  assert.equal(confirmed!.paymentMethod, 'store_credit')
  assert.equal(confirmed!.payments, undefined)
  assert.equal(confirmed!.customerId, 1)
  assert.equal(confirmed!.expectedTotal, 850)
})
