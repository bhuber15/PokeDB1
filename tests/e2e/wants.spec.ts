import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// Wants merged into the Customers page (docs/testing/smoke-2026-07-06.md):
// no standalone nav tab, /wants redirects, and the cross-customer Want List
// view still shows in-stock status with a working Sell deep link.
test('want list lives under Customers: add a want, see it cross-customer, Sell link works', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  const nav = page.getByRole('navigation')
  await expect(nav.getByRole('link', { name: 'Wants' })).toHaveCount(0)

  // Create a customer
  await nav.getByRole('link', { name: 'Customers' }).click()
  await page.waitForURL('**/customers')
  await page.getByRole('button', { name: '+ New customer' }).click()
  await page.getByPlaceholder('Full name').fill('Ash Ketchum')
  await page.getByRole('button', { name: 'Create customer' }).click()
  await expect(page.getByRole('cell', { name: 'Ash Ketchum' })).toBeVisible()

  // Add a want for the seeded, in-stock Pikachu card
  await page.getByRole('link', { name: 'View' }).click()
  await page.getByRole('button', { name: 'Search card' }).click()
  await page.getByPlaceholder(/search card name/i).fill('Pikachu')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('button', { name: /Pikachu/ }).click()
  await page.getByRole('button', { name: 'Add to want list' }).click()
  await expect(page.getByText('Want added')).toBeVisible()

  // Cross-customer Want List tab — staff need "what should I pull from new stock".
  // The wanted Pikachu is in stock, so it surfaces in the grouped "ready to sell"
  // panel with a POS deep link, and Ash is listed there as a waiting customer.
  await nav.getByRole('link', { name: 'Customers' }).click()
  await page.getByRole('button', { name: 'Want List' }).click()
  const inStock = page.locator('section').filter({ has: page.getByRole('heading', { name: /in stock now/i }) })
  await expect(inStock.getByRole('link', { name: /sell/i })).toHaveAttribute('href', '/pos?q=Pikachu')
  await expect(inStock.getByRole('link', { name: 'Ash Ketchum' })).toBeVisible()

  // Old /wants URL still resolves via redirect
  await page.goto('/wants')
  await expect(page).toHaveURL(/\/customers\?view=wants$/)
  await expect(page.getByText('Outstanding wants across every customer')).toBeVisible()

  // DB agrees: one open want, tied to the right card and customer
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const rows = await client.execute(`
      SELECT want_list.card_id as cardId, want_list.fulfilled_at as fulfilledAt, customers.name as customerName
      FROM want_list JOIN customers ON customers.id = want_list.customer_id
    `)
    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0].cardId)).toBe(1)
    expect(rows.rows[0].fulfilledAt).toBeNull()
    expect(rows.rows[0].customerName).toBe('Ash Ketchum')
  } finally {
    client.close()
  }
})
