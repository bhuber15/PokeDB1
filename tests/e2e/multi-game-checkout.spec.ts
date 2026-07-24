import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// Multi-game checkout (Task 12): with Magic + Yu-Gi-Oh! enabled alongside
// Pokémon, the game-first selector (Task 9) renders on the POS, scopes
// search to one game, and both a Magic foil and a Yu-Gi-Oh! printing ring up
// through the ordinary priced-override path — same calculateSellPrice a
// Pokémon card uses (checkout.spec.ts), just with game/variant metadata
// attached. DB assertions are scoped by this spec's own qr codes rather than
// absolute table counts, so they hold regardless of what order the other
// shared-seed specs run in.
test('staff can sell a Magic foil and a Yu-Gi-Oh! printing via the game-first selector', async ({ page }) => {
  // Owner unlock → staff PIN (same preamble as checkout.spec.ts)
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  const gameFilter = page.getByRole('group', { name: 'Filter by game' })
  const searchBox = page.getByPlaceholder(/scan barcode/i)
  const searchButton = page.getByRole('button', { name: 'Search', exact: true })

  // The selector only appears once more than one game is enabled — confirms
  // the seed's enabledGames actually reached the client via SettingsProvider.
  await expect(gameFilter).toBeVisible()

  // Scope to Magic, search its foil card, confirm the game badge + price, add to cart
  await gameFilter.getByRole('button', { name: 'Magic', exact: true }).click()
  await searchBox.fill('Lightning Bolt')
  await searchButton.click()
  const mtgResult = page.locator('div.border.rounded-xl', { hasText: 'Lightning Bolt' })
  await expect(mtgResult).toBeVisible()
  await expect(mtgResult.getByText('Magic', { exact: true })).toBeVisible()
  await expect(mtgResult.getByText('£12.00').first()).toBeVisible()
  await mtgResult.getByRole('button', { name: 'Add to Cart' }).click()

  // Switch to Yu-Gi-Oh!, search its printing, confirm badge + price, add to cart
  await gameFilter.getByRole('button', { name: 'Yu-Gi-Oh!', exact: true }).click()
  await searchBox.fill('Blue-Eyes White Dragon')
  await searchButton.click()
  const ygoResult = page.locator('div.border.rounded-xl', { hasText: 'Blue-Eyes White Dragon' })
  await expect(ygoResult).toBeVisible()
  await expect(ygoResult.getByText('Yu-Gi-Oh!', { exact: true })).toBeVisible()
  await expect(ygoResult.getByText('£3.50').first()).toBeVisible()
  await ygoResult.getByRole('button', { name: 'Add to Cart' }).click()

  // Cart totals and checkout: £12.00 (Magic) + £3.50 (Yu-Gi-Oh!) = £15.50.
  // Customer pays with a twenty — the till must show £4.50 change.
  await expect(page.getByText('Subtotal')).toBeVisible()
  await page.getByRole('button', { name: 'Checkout' }).click()
  await page.getByLabel(/cash received/i).fill('20.00')
  await expect(page.getByText('Change')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm £15.50' }).click()

  // Success feedback and cart reset
  await expect(page.getByText(/Sale complete.*Change £4\.50/)).toBeVisible()
  await expect(page.getByText('Cart is empty')).toBeVisible()

  // The database agrees: one sale carrying both priced items at their seeded
  // values, and both items' stock decremented by the one unit sold. Found by
  // this spec's own qr_codes (fresh rows nothing else touches) rather than an
  // absolute row count on the shared `sales`/`inventory_items` tables, so this
  // holds no matter where this spec falls in the run relative to the others.
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const saleRows = await client.execute(`
      SELECT DISTINCT s.id AS saleId, s.total AS total, s.payment_method AS paymentMethod
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN inventory_items ii ON ii.id = si.inventory_item_id
      WHERE ii.qr_code IN ('e2e-mtg-foil-qr', 'e2e-ygo-printing-qr')
    `)
    expect(saleRows.rows).toHaveLength(1)
    expect(Number(saleRows.rows[0].total)).toBe(1550)
    expect(saleRows.rows[0].paymentMethod).toBe('cash')

    const mtgItem = await client.execute(
      `SELECT quantity FROM inventory_items WHERE qr_code = 'e2e-mtg-foil-qr'`)
    expect(Number(mtgItem.rows[0].quantity)).toBe(1) // 2 seeded − 1 sold

    const ygoItem = await client.execute(
      `SELECT quantity FROM inventory_items WHERE qr_code = 'e2e-ygo-printing-qr'`)
    expect(Number(ygoItem.rows[0].quantity)).toBe(4) // 5 seeded − 1 sold
  } finally {
    client.close()
  }
})
