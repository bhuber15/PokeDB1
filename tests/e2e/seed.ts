import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import bcrypt from 'bcryptjs'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../../lib/db/schema'
import { applyMigrations } from '../../lib/db/test-helpers'
import { E2E_DB_PATH, STAFF_PIN } from './env'

// Builds a fresh throwaway shop database: one staff member, one card with
// priced stock, default settings. Runs as the first half of the Playwright
// webServer command (see playwright.config.ts) so it always precedes the
// server boot — the libsql client opens the file eagerly at startup.
async function seed() {
  mkdirSync(dirname(E2E_DB_PATH), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(E2E_DB_PATH + suffix) } catch { /* first run */ }
  }
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  await applyMigrations(client)
  const db = drizzle(client, { schema })

  await db.insert(schema.settings).values({ id: 1 })
  await db.insert(schema.staff).values({
    id: 1, name: 'Tess', pinHash: bcrypt.hashSync(STAFF_PIN, 4), role: 'staff',
  })
  await db.insert(schema.cards).values({
    id: 1, name: 'Pikachu', setName: 'Base Set', setNumber: '58/102',
  })
  await db.insert(schema.inventoryItems).values({
    id: 1, cardId: 1, condition: 'NM', quantity: 3,
    costPrice: 200, sellPriceOverride: 500, // £5.00 sell price, pence
    qrCode: 'e2e-0000-qr',
  })
  await db.insert(schema.products).values({
    id: 1, name: 'SV Booster Pack', category: 'sealed', ean: '5060000000017',
  })
  await db.insert(schema.inventoryItems).values({
    id: 2, productId: 1, condition: 'NA', quantity: 4,
    costPrice: 250, sellPriceOverride: 450, // £4.50
    qrCode: 'e2e-0001-qr',
  })

  // JA card with no price_cache row and no override — the till quick-set
  // flow (Task 9) prices it manually. Deliberately a species no other spec
  // searches for (the seed has no EN Charizard): now that in-stock search
  // matches aliases, a 'Pikachu' alias here would leak this card into
  // checkout/search-enter's unscoped 'Pikachu' locators (strict-mode
  // violations on shared texts like "NM · 2 in stock").
  const [jaCard] = await db.insert(schema.cards).values({
    name: 'リザードン', aliasName: 'Charizard', game: 'pokemon', language: 'JA',
    setName: 'テストセット', setNumber: '099', externalId: 'tcgdex:ja:TEST-099',
  }).returning()
  await db.insert(schema.inventoryItems).values({
    cardId: jaCard.id, condition: 'NM', quantity: 2, costPrice: 100,
    qrCode: 'e2e-ja-quickset',
  })

  client.close()
  console.log(`e2e database seeded at ${E2E_DB_PATH}`)
}

seed().catch(e => { console.error(e); process.exit(1) })
