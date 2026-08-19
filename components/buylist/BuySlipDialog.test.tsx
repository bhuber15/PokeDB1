import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup } from '@testing-library/react'
import { BuySlipDialog, type BuySlipData } from './BuySlipDialog'

afterEach(cleanup)

function slip(overrides: Partial<BuySlipData>): BuySlipData {
  return {
    buyId: 7,
    at: new Date().toISOString(),
    method: 'store_credit',
    total: 650,
    customerId: 3,
    customerName: 'Dave',
    lines: [{ cardName: 'Pikachu', condition: 'LP', quantity: 1, payPrice: 650 }],
    ...overrides,
  }
}

test('store-credit buy offers a Sell handoff link carrying the customer to the POS', async () => {
  render(<BuySlipDialog slip={slip({})} onClose={() => {}} />)
  const link = await screen.findByRole('link', { name: /sell to dave/i })
  assert.equal(link.getAttribute('href'), '/pos?customerId=3')
  assert.match(link.textContent ?? '', /£6\.50 credit/)
})

test('no handoff link on a cash buy or a walk-in credit buy', async () => {
  render(<BuySlipDialog slip={slip({ method: 'cash' })} onClose={() => {}} />)
  await screen.findByText(/Paid \(cash\)/)
  assert.equal(screen.queryByRole('link', { name: /sell to/i }), null)
  cleanup()

  render(<BuySlipDialog slip={slip({ customerId: null, customerName: null })} onClose={() => {}} />)
  await screen.findByText(/Paid \(store credit\)/)
  assert.equal(screen.queryByRole('link', { name: /sell to/i }), null)
})

test('product lines print without a condition', async () => {
  render(<BuySlipDialog
    slip={slip({ lines: [{ cardName: 'Booster Box SV', condition: 'NA', quantity: 1, payPrice: 9000, productId: 1 } as never] })}
    onClose={() => {}}
  />)
  await screen.findByText(/Booster Box SV/)
  assert.equal(screen.queryByText(/\bNA\b/), null)
})
