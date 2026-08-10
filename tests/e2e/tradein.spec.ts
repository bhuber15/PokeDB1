import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// Trade-in flow: a customer sells the shop a card for store credit and puts
// the credit straight toward a purchase in the same counter interaction.
// Buylist buy (store credit) → "Sell to" handoff on the buy slip → POS
// banner + preselected checkout customer → one-tap credit application as a
// split tender. LP condition on the buy keeps the seeded NM row untouched
// for the other specs sharing this DB.
test('trade-in credit flows from a buy into the same visit sale', async ({ page }) => {
  // Owner unlock + staff PIN (same dance as checkout.spec)
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  // Buylist: trade in an LP Pikachu for £3.00 of store credit. The seed has
  // no market price for it, so the offer is entered manually.
  await page.goto('/buylist')
  await page.getByPlaceholder('Search card name to buy…').fill('Pikachu')
  await page.getByPlaceholder('Search card name to buy…').press('Enter')
  await expect(page.getByRole('heading', { name: 'Pikachu' })).toBeVisible()
  await page.getByRole('button', { name: 'LP', exact: true }).click()
  await page.getByLabel('Manual cash offer in pounds').fill('2.50')
  await page.getByLabel('Manual credit offer in pounds').fill('3.00')
  await page.getByRole('button', { name: 'Add to buy' }).click()

  // Store credit needs a customer — create one inline from the picker.
  await page.getByRole('button', { name: 'Store Credit' }).click()
  await page.getByPlaceholder('Search customer by name…').fill('Trade-in Tina')
  await page.getByRole('button', { name: '+ New customer' }).click()
  await page.getByPlaceholder('Customer name').fill('Trade-in Tina')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: /Confirm buy \(Credit\)/ }).click()

  // The buy slip offers the natural next step and carries the customer over.
  // Generous timeout: this is the suite's first-ever /api/buys hit, and the
  // dev server may still be compiling the route mid-suite.
  const sellTo = page.getByRole('link', { name: /Sell to Trade-in Tina/ })
  await expect(sellTo).toContainText('£3.00 credit', { timeout: 15_000 })
  await sellTo.click()
  await page.waitForURL(/\/pos/)

  // POS banner: who we're selling to and their just-posted credit. The
  // customerId param is consumed and stripped so a reload can't re-attach.
  await expect(page.getByText('Selling to Trade-in Tina · £3.00 credit')).toBeVisible()
  expect(page.url()).not.toContain('customerId')

  // Ring up the £5.00 NM Pikachu.
  await page.getByPlaceholder(/scan barcode/i).fill('Pikachu')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByText(/NM · \d+ in stock/)).toBeVisible()
  await page.getByRole('button', { name: 'Add to Cart' }).click()
  await page.getByRole('button', { name: 'Checkout' }).click()

  // The trade-in customer arrives preselected, balance fetched…
  await expect(page.getByText('Balance: £3.00')).toBeVisible()
  // …and one tap applies the credit with the remainder on card.
  await page.getByRole('button', { name: /Apply store credit/ }).click()
  await expect(page.getByText('Fully allocated')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm £5.00' }).click()

  // Sale lands; the trade-in interaction is complete so the banner clears.
  await expect(page.getByText(/Sale complete — £5\.00/)).toBeVisible()
  await expect(page.getByText(/Selling to/)).toHaveCount(0)

  // The ledger tells the whole story: +300 from the buy, −300 into the sale,
  // and the sale settled as a store_credit + card split.
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const ledger = await client.execute(
      "SELECT delta, reason, ref_type FROM credit_ledger WHERE customer_id = (SELECT id FROM customers WHERE name = 'Trade-in Tina') ORDER BY id",
    )
    expect(ledger.rows.map(r => [Number(r.delta), r.reason, r.ref_type])).toEqual([
      [300, 'buylist', 'buy'],
      [-300, 'sale', 'sale'],
    ])
    const pays = await client.execute(
      "SELECT method, amount FROM sale_payments WHERE sale_id = (SELECT ref_id FROM credit_ledger WHERE reason = 'sale' AND customer_id = (SELECT id FROM customers WHERE name = 'Trade-in Tina')) ORDER BY method",
    )
    expect(pays.rows.map(r => [r.method, Number(r.amount)])).toEqual([
      ['card', 200],
      ['store_credit', 300],
    ])
  } finally {
    client.close()
  }
})
