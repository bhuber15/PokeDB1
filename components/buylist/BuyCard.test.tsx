import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BuyCard, type BuyLineInput } from './BuyCard'
import { SettingsProvider } from '@/components/shared/SettingsProvider'
import { DEFAULT_CONDITION_LADDER, RECOMMENDED_CONDITION_LADDER } from '@/lib/pricing'
import type { AppSettings } from '@/lib/settings'
import type { Card, PriceCache } from '@/lib/db/schema'

afterEach(cleanup)

const settings = (ladder: AppSettings['conditionSellPct']): AppSettings => ({
  shopName: 'Test', usdToGbp: 0.79, eurToGbp: 0.86, marginMultiplier: 0.85,
  highValueThreshold: 5000, buyCashPct: 0.5, buyCreditPct: 0.65,
  primaryPriceSource: 'cardmarket', vatScheme: 'none', marginNoCostHandling: 'exclude',
  enabledLanguages: ['EN'], conditionSellPct: ladder,
})

// Minimal fixtures — no image URLs so next/image never renders in the test DOM.
const card = { id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102', variant: null, imageUrl: null, imageUrlLarge: null } as unknown as Card
const prices = { cardId: 1, cardmarketTrend: 1000, tcgplayerMarket: null } as unknown as PriceCache

function renderBuyCard(ladder: AppSettings['conditionSellPct'], onAdd: (l: BuyLineInput) => void = () => {}) {
  return render(
    <SettingsProvider value={settings(ladder)}>
      <BuyCard card={card} prices={prices} onAdd={onAdd} />
    </SettingsProvider>,
  )
}

test('offers scale with the selected condition (MP 70%: cash floor(700×0.5) = £3.50)', () => {
  renderBuyCard(RECOMMENDED_CONDITION_LADDER)
  assert.ok(screen.getByText('Cash £5.00')) // NM default
  fireEvent.click(screen.getByRole('button', { name: 'MP' }))
  assert.ok(screen.getByText('Cash £3.50'))
  assert.ok(screen.getByText('Credit £4.55')) // floor(700×0.65)
  assert.ok(screen.getByText('Market £10.00')) // raw market badge unchanged
})

test('all-100 ladder: offers identical for every condition (no-op default)', () => {
  renderBuyCard({ ...DEFAULT_CONDITION_LADDER })
  fireEvent.click(screen.getByRole('button', { name: 'DMG' }))
  assert.ok(screen.getByText('Cash £5.00'))
})

test('Add to buy sends condition-adjusted pay prices', () => {
  let added: BuyLineInput | null = null
  renderBuyCard(RECOMMENDED_CONDITION_LADDER, l => { added = l })
  fireEvent.click(screen.getByRole('button', { name: 'HP' })) // conditioned = 500
  fireEvent.click(screen.getByRole('button', { name: 'Add to buy' }))
  assert.deepEqual(added, { cardId: 1, condition: 'HP', quantity: 1, payPriceCash: 250, payPriceCredit: 325 })
})
