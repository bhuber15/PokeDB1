import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// A JA card with no market price: found via its EN species alias, priced at
// the till (quick-set persists the override), then sold for that price.
test('staff can price and sell a no-market-price JA card at the till', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  // Alias search finds the JA printing, flagged with its language badge.
  // 'Charizard' matches only the JA row in this seed; locators stay scoped
  // to its result container anyway for robustness against future seeds.
  await page.getByPlaceholder(/scan barcode/i).fill('Charizard')
  await page.getByRole('button', { name: 'Search' }).click()
  const jaCard = page.locator('div.border.rounded-xl', { hasText: 'リザードン' })
  await expect(jaCard).toBeVisible()
  await expect(jaCard.getByText('Japanese')).toBeVisible()

  // No price → quick-set at the till (only the JA card renders this UI)
  await expect(jaCard.getByText(/no price — set one to sell/i)).toBeVisible()
  await jaCard.getByLabel('Set selling price in pounds').fill('7.50')
  await jaCard.getByRole('button', { name: 'Set price' }).click()

  // Refresh re-derives the sell price from the persisted override
  await expect(jaCard.getByText('£7.50')).toBeVisible()
  await jaCard.getByRole('button', { name: 'Add to Cart' }).click()

  // Cash checkout, £10 tendered against £7.50 → £2.50 change
  await page.getByRole('button', { name: 'Checkout' }).click()
  await page.getByLabel(/cash received/i).fill('10.00')
  await expect(page.getByText('Change')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm £7.50' }).click()
  await expect(page.getByText(/Sale complete.*Change £2\.50/)).toBeVisible()

  // The database agrees: 750p cash sale, and the override persisted on the item
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const sales = await client.execute(`SELECT total FROM sales ORDER BY id DESC LIMIT 1`)
    expect(Number(sales.rows[0].total)).toBe(750)
    const item = await client.execute(
      `SELECT sell_price_override, quantity FROM inventory_items WHERE qr_code = 'e2e-ja-quickset'`)
    expect(Number(item.rows[0].sell_price_override)).toBe(750)
    expect(Number(item.rows[0].quantity)).toBe(1)
  } finally {
    client.close()
  }
})
