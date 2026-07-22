import { test, expect } from '@playwright/test'
import { OWNER_PASSWORD, STAFF_PIN } from './env'

// A USB barcode scanner types its payload and sends Enter — it never clicks
// the Search button. Enter must therefore submit both search boxes exactly
// like the button does. Quantities are asserted loosely because earlier
// specs in the run buy/sell stock from the same seeded DB.
test('Enter submits the POS and buylist searches (scanner-compatible)', async ({ page }) => {
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

  // POS: type a name, press Enter — no Search click
  const posBox = page.getByPlaceholder(/scan barcode/i)
  await posBox.fill('Pikachu')
  await posBox.press('Enter')
  await expect(page.getByText(/NM · \d+ in stock/)).toBeVisible()

  // POS: the box must have regained focus after the search (the input is
  // disabled while loading, which drops focus) — a scanner never clicks.
  // Second search is fully hands-free: raw keystrokes + Enter, EAN digits
  // like a USB scanner sends.
  await expect(posBox).toBeFocused()
  await page.keyboard.type('5060000000017')
  await page.keyboard.press('Enter')
  await expect(page.getByText('SV Booster Pack')).toBeVisible()

  // Buylist: type a name, press Enter
  await page.goto('/buylist')
  const buyBox = page.getByPlaceholder(/search card name to buy/i)
  await buyBox.fill('Pikachu')
  await buyBox.press('Enter')
  await expect(page.getByRole('heading', { name: 'Pikachu' })).toBeVisible()

  // Buylist regains focus after the search too, so back-to-back keyboard
  // searches work without reaching for the mouse. (Unlike the POS box the
  // query is kept after searching, so select-all before retyping.)
  await expect(buyBox).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Pikachu')
  await expect(buyBox).toHaveValue('Pikachu')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Pikachu' })).toBeVisible()
})
