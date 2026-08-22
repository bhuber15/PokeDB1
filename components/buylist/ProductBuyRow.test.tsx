import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ProductBuyRow } from './ProductBuyRow'

afterEach(cleanup)

const product = { id: 1, name: 'Booster Box SV', category: 'sealed', ean: '5060000000017', createdAt: '' }

test('adds a product line with the typed pay price in pence, no condition', () => {
  let line: unknown
  render(<ProductBuyRow product={product as never} onAdd={l => { line = l }} />)
  fireEvent.change(screen.getByLabelText(/pay price/i), { target: { value: '90.00' } })
  fireEvent.click(screen.getByRole('button', { name: /add/i }))
  assert.deepEqual(line, {
    productId: 1, cardName: 'Booster Box SV', quantity: 1,
    payPriceCash: 9000, payPriceCredit: 9000,
  })
})

test('blocks add until a price is typed', () => {
  render(<ProductBuyRow product={product as never} onAdd={() => {}} />)
  const btn = screen.getByRole('button', { name: /add/i })
  assert.equal(btn.hasAttribute('disabled'), true)
})
