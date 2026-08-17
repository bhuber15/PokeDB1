import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { OfflineBanner } from './OfflineBanner'

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

test('renders nothing while online', () => {
  render(<OfflineBanner />)
  assert.equal(screen.queryByRole('status'), null)
})

test('appears offline with the honest capability summary, disappears online', () => {
  render(<OfflineBanner />)
  setNavigatorOnline(false)
  fireEvent.offline(window)
  const banner = screen.getByRole('status')
  assert.match(banner.textContent ?? '', /sales will queue/i)
  assert.match(banner.textContent ?? '', /search, buys and refunds need a connection/i)
  setNavigatorOnline(true)
  fireEvent.online(window)
  assert.equal(screen.queryByRole('status'), null)
})
