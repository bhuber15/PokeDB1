import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, STAFF_PIN } from './env'

// Rapid intake loop: search stays in flow after each add, Enter-driven,
// Ctrl+Enter repeats the last card. Uses LP so it never collides with the
// NM row the checkout spec sells from (runs after it — workers: 1).
test('rapid intake: keyboard-only add, session list, repeat last card', async ({ page }) => {
  // Owner unlock → staff PIN
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/pin')
  for (const digit of STAFF_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  await page.goto('/inventory/add')

  // Search with Enter, pick the highlighted result with Enter
  const search = page.getByPlaceholder(/search card name/i)
  await search.fill('Pikachu')
  await search.press('Enter')
  await expect(page.getByRole('button', { name: /Pikachu/ })).toBeVisible()
  await search.press('Enter')

  // Detail view: cost field is auto-focused; LP condition, £2.50, Enter saves
  const cost = page.getByLabel(/cost price/i)
  await expect(cost).toBeFocused()
  await page.getByRole('button', { name: 'LP', exact: true }).click()
  await cost.fill('2.50')
  await cost.press('Enter')

  // Back in flow: search refocused, session list shows the add
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  const aside = page.getByRole('complementary', { name: /added this session/i })
  await expect(aside.getByText('Pikachu')).toBeVisible()
  await expect(aside.getByText('1 card added')).toBeVisible()

  // Ctrl+Enter adds another copy of the last card without touching the form
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(aside.getByText('2 cards added')).toBeVisible()

  // DB agrees: merged LP row for card 1 with qty 2 at 250p
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    const rows = await client.execute(
      "SELECT quantity, cost_price FROM inventory_items WHERE card_id = 1 AND condition = 'LP' AND is_active = 1",
    )
    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0].quantity)).toBe(2)
    expect(Number(rows.rows[0].cost_price)).toBe(250)
  } finally {
    client.close()
  }
})
