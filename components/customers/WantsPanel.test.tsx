import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup } from '@testing-library/react'
import { WantsPanel } from './WantsPanel'

afterEach(cleanup)

function mockFetchOnce(body: unknown, ok = true) {
  global.fetch = (async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch
}

test('renders an in-stock want with a Sell link to the right card', async () => {
  mockFetchOnce({
    wants: [{
      id: 1,
      customerId: 7,
      cardId: 3,
      freeText: null,
      notify: true,
      createdAt: new Date().toISOString(),
      customerName: 'Ash Ketchum',
      cardName: 'Pikachu',
      cardSetName: 'Base Set',
      cardSetNumber: '58/102',
      inStock: true,
    }],
  })

  render(<WantsPanel />)

  const sellLink = await screen.findByRole('link', { name: /sell/i })
  assert.equal(sellLink.getAttribute('href'), '/pos?q=Pikachu')
  assert.ok(screen.getByText('In stock'))
  assert.ok(screen.getByText('Ash Ketchum'))
})

test('renders a not-in-stock want with no Sell link', async () => {
  mockFetchOnce({
    wants: [{
      id: 2,
      customerId: 8,
      cardId: null,
      freeText: 'Charizard VMAX secret rare',
      notify: true,
      createdAt: new Date().toISOString(),
      customerName: 'Misty',
      cardName: null,
      cardSetName: null,
      cardSetNumber: null,
      inStock: false,
    }],
  })

  render(<WantsPanel />)

  await screen.findByText('Charizard VMAX secret rare')
  assert.ok(screen.getByText('Not in stock'))
  assert.equal(screen.queryByRole('link', { name: /sell/i }), null)
})

test('shows the empty state when there are no open wants', async () => {
  mockFetchOnce({ wants: [] })

  render(<WantsPanel />)

  assert.ok(await screen.findByText('No open wants'))
})
