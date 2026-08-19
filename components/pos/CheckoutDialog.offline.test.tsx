import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CheckoutDialog } from './CheckoutDialog'

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

const item = { inventoryItemId: 1, name: 'Pikachu', condition: 'NM', quantity: 1, price: 850 }

test('offline: confirm reads Queue sale and store credit is locked', () => {
  setNavigatorOnline(false)
  render(<CheckoutDialog open items={[item as never]} onClose={() => {}} onConfirm={async () => {}} />)
  fireEvent.offline(window)
  assert.ok(screen.getByRole('button', { name: /queue sale/i }))
  const credit = screen.getByRole('button', { name: /store credit/i })
  assert.equal(credit.hasAttribute('disabled'), true)
})

test('online: confirm shows the total as before', () => {
  render(<CheckoutDialog open items={[item as never]} onClose={() => {}} onConfirm={async () => {}} />)
  assert.ok(screen.getByRole('button', { name: /confirm £8\.50/i }))
})
