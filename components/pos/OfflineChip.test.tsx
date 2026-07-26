import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { OfflineChip } from './OfflineChip'

// jsdom pins navigator.onLine at true and doesn't flip it for dispatched
// events, so shadow the getter per-test; the hook's snapshot reads it on
// each online/offline notification.
function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
}

afterEach(cleanup)
afterEach(() => setNavigatorOnline(true))

test('renders nothing while online', () => {
  render(<OfflineChip />)
  assert.equal(screen.queryByText(/Offline — sales will queue/), null)
})

test('appears on the offline event and disappears on online', () => {
  render(<OfflineChip />)
  setNavigatorOnline(false)
  fireEvent.offline(window)
  assert.ok(screen.getByText('Offline — sales will queue'))
  setNavigatorOnline(true)
  fireEvent.online(window)
  assert.equal(screen.queryByText(/Offline — sales will queue/), null)
})

test('is announced politely to screen readers', () => {
  render(<OfflineChip />)
  setNavigatorOnline(false)
  fireEvent.offline(window)
  const chip = screen.getByRole('status')
  assert.match(chip.textContent ?? '', /Offline — sales will queue/)
})
