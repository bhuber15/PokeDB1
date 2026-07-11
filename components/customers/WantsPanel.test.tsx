import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { WantsPanel } from './WantsPanel'

afterEach(cleanup)

let fetchCalls: { url: string; init?: RequestInit }[] = []

function mockFetch(body: unknown, ok = true) {
  fetchCalls = []
  global.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    return { ok, json: async () => body }
  }) as unknown as typeof fetch
}

function want(overrides: Record<string, unknown>) {
  return {
    id: 1, customerId: 7, cardId: 3, freeText: null, notify: true,
    createdAt: new Date().toISOString(),
    customerName: 'Ash Ketchum', customerPhone: '07700 900111', customerEmail: 'ash@example.com',
    cardName: 'Pikachu', cardSetName: 'Base Set', cardSetNumber: '58/102',
    inStock: true, ...overrides,
  }
}

test('shows an in-stock want with contact info and a Sell link to the card', async () => {
  mockFetch({ wants: [want({})] })

  render(<WantsPanel />)

  await screen.findAllByText('Ash Ketchum')
  assert.ok(screen.getByText('07700 900111'))
  assert.ok(screen.getByText('ash@example.com'))
  const sellLinks = screen.getAllByRole('link', { name: /sell/i })
  assert.ok(sellLinks.some(a => a.getAttribute('href') === '/pos?q=Pikachu'))
})

test('empty in-stock section when the only want is a free-text miss', async () => {
  mockFetch({ wants: [want({
    id: 2, cardId: null, freeText: 'Charizard VMAX secret rare',
    cardName: null, cardSetName: null, cardSetNumber: null, inStock: false,
  })] })

  render(<WantsPanel />)

  await screen.findByText('No wanted cards are in stock right now')
  assert.ok(screen.getByText('Charizard VMAX secret rare'))
  assert.equal(screen.queryByRole('link', { name: /sell/i }), null)
})

test('shows both empty states when there are no open wants', async () => {
  mockFetch({ wants: [] })

  render(<WantsPanel />)

  assert.ok(await screen.findByText('No open wants'))
  assert.ok(screen.getByText('No wanted cards are in stock right now'))
})

test('toggling notify PATCHes the want', async () => {
  mockFetch({ wants: [want({})] })

  render(<WantsPanel />)

  const checkbox = await screen.findByLabelText(/notify/i)
  fireEvent.click(checkbox)
  await new Promise(r => setTimeout(r, 0))

  const patch = fetchCalls.find(c => c.init?.method === 'PATCH')
  assert.ok(patch, 'expected a PATCH call')
  assert.equal(patch!.url, '/api/wants?id=1')
  assert.deepEqual(JSON.parse(patch!.init!.body as string), { notify: false })
})
