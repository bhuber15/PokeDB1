import { test, expect } from '@playwright/test'
import { createClient } from '@libsql/client'
import { E2E_DB_PATH, OWNER_PASSWORD, ADMIN_PIN } from './env'

// CSV import round-trip now that the name/set_number card match is
// identity-scoped by (game, name, set_number, language): one row with
// explicit game/language columns, and a legacy row that omits them
// (defaulting to pokemon/EN, so old CSVs keep importing unchanged).
// Re-importing the identical file must find both existing cards rather than
// duplicating them — the route always creates a new inventory_items row per
// import though (app/api/inventory/import/route.ts). Import is admin-gated
// (requireAdmin), so this logs in with the admin PIN, not the ordinary
// cashier STAFF_PIN the other specs use.
const CSV =
  'name,set_name,set_number,condition,quantity,cost_price,game,language\n' +
  'テストカード,テストセット,777,NM,1,2.00,pokemon,JA\n' +
  'Legacy Row Card,Legacy Set,888,NM,1,1.00,,\n'

test('CSV import round-trip: game/language columns, legacy defaults, identity-scoped re-import', async ({ page }) => {
  // Owner unlock → admin PIN (CSV import requires the admin role)
  await page.goto('/')
  await page.waitForURL('**/login')
  await page.getByLabel('Password').fill(OWNER_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/pin')
  for (const digit of ADMIN_PIN) {
    await page.getByRole('button', { name: `Digit ${digit}` }).click()
  }
  await page.waitForURL('**/pos')

  await page.goto('/inventory')
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible()

  // Open the import dialog
  await page.getByRole('button', { name: 'Import CSV' }).click()
  await expect(page.getByText('Import Inventory CSV')).toBeVisible()
  const fileInput = page.locator('input[type="file"]')
  const importButton = page.getByRole('button', { name: 'Import', exact: true })

  // Re-importing the identical CSV produces an identical "Imported 2 items"
  // toast, so toast text alone can't distinguish the two calls (the first
  // can still be fading out when the second fires). Wait on the actual API
  // response and assert its JSON body directly; the toast/row-errors checks
  // below then confirm the UI reflects that same result.
  async function importCsv() {
    await fileInput.setInputFiles({ name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) })
    const [response] = await Promise.all([
      page.waitForResponse(res =>
        res.url().includes('/api/inventory/import') && res.request().method() === 'POST'),
      importButton.click(),
    ])
    expect(response.ok()).toBe(true)
    return response.json() as Promise<{ created: number; errors: { row: number; message: string }[] }>
  }

  const first = await importCsv()
  expect(first.created).toBe(2)
  expect(first.errors).toEqual([])
  await expect(page.getByText('Imported 2 items').last()).toBeVisible()
  await expect(page.getByText(/^Row \d+$/)).toHaveCount(0)

  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  try {
    // JA row: explicit game/language columns land as given, and the match
    // is scoped so it can never collide with an EN card sharing this number.
    const ja = await client.execute(
      `SELECT id, name FROM cards WHERE game = 'pokemon' AND language = 'JA' AND set_number = '777'`)
    expect(ja.rows).toHaveLength(1)
    expect(ja.rows[0].name).toBe('テストカード')
    const jaCardId = Number(ja.rows[0].id)

    // Legacy row: blank game/language columns defaulted to pokemon/EN.
    const legacy = await client.execute(
      `SELECT id, game, name FROM cards WHERE language = 'EN' AND set_number = '888'`)
    expect(legacy.rows).toHaveLength(1)
    expect(legacy.rows[0].game).toBe('pokemon')
    expect(legacy.rows[0].name).toBe('Legacy Row Card')
    const legacyCardId = Number(legacy.rows[0].id)

    const jaItems = await client.execute(`SELECT quantity FROM inventory_items WHERE card_id = ${jaCardId}`)
    expect(jaItems.rows).toHaveLength(1)
    expect(Number(jaItems.rows[0].quantity)).toBe(1)

    const legacyItems = await client.execute(`SELECT quantity FROM inventory_items WHERE card_id = ${legacyCardId}`)
    expect(legacyItems.rows).toHaveLength(1)
    expect(Number(legacyItems.rows[0].quantity)).toBe(1)

    // Re-import the identical file (dialog stays open; only the file input
    // resets after a successful import, so re-attaching it is enough).
    const second = await importCsv()
    expect(second.created).toBe(2)
    expect(second.errors).toEqual([])
    await expect(page.getByText('Imported 2 items').last()).toBeVisible()

    // Identity-scoped match found the existing cards instead of duplicating
    // them — still exactly one row per (game, name, set_number, language).
    const jaCardCount = await client.execute(`SELECT count(*) as c FROM cards WHERE set_number = '777'`)
    expect(Number(jaCardCount.rows[0].c)).toBe(1)
    const legacyCardCount = await client.execute(`SELECT count(*) as c FROM cards WHERE set_number = '888'`)
    expect(Number(legacyCardCount.rows[0].c)).toBe(1)

    // But the route always inserts a NEW inventory item per row, even when
    // the card itself matched — so each card now carries two items.
    const jaItemsAfter = await client.execute(`SELECT quantity FROM inventory_items WHERE card_id = ${jaCardId}`)
    expect(jaItemsAfter.rows).toHaveLength(2)
    expect(jaItemsAfter.rows.reduce((sum, r) => sum + Number(r.quantity), 0)).toBe(2)

    const legacyItemsAfter = await client.execute(`SELECT quantity FROM inventory_items WHERE card_id = ${legacyCardId}`)
    expect(legacyItemsAfter.rows).toHaveLength(2)
  } finally {
    client.close()
  }
})
