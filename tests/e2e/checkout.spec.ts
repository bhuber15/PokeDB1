import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// Golden path: owner unlock → staff PIN → search a card → add to cart →
// cash checkout → sale recorded and stock decremented.
test('staff can ring up a cash sale end to end', async ({ page }) => {
  // Owner unlock (middleware redirects everything here first)
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  // Staff PIN pad
  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  // Search the seeded card; first stock option is auto-selected
  await page.getByPlaceholder(/scan qr label/i).fill('Pikachu')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByText('NM · 3 in stock')).toBeVisible()
  await expect(page.getByText('£5.00').first()).toBeVisible()
  await page.getByRole('button', { name: 'Add to Cart' }).click()

  // Cart totals and checkout (cash is the default, no discount)
  await expect(page.getByText('Subtotal')).toBeVisible()
  await page.getByRole('button', { name: 'Checkout' }).click()
  await page.getByRole('button', { name: 'Confirm £5.00' }).click()

  // Success feedback and cart reset
  await expect(page.getByText(/Sale complete/)).toBeVisible()
  await expect(page.getByText('Cart is empty')).toBeVisible()

  // The database agrees: one 500p cash sale, stock down from 3 to 2
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const sales = await client.execute('SELECT total, payment_method FROM sales')
    expect(sales.rows).toHaveLength(1)
    expect(Number(sales.rows[0].total)).toBe(500)
    expect(sales.rows[0].payment_method).toBe('cash')

    const inv = await client.execute('SELECT quantity FROM inventory_items WHERE id = 1')
    expect(Number(inv.rows[0].quantity)).toBe(2)
  } finally {
    client.close()
  }
})
