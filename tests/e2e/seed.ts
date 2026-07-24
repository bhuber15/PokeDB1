import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import bcrypt from 'bcryptjs'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../../lib/db/schema'
import { applyMigrations } from '../../lib/db/test-helpers'
import { E2E_DB_PATH, STAFF_PIN, ADMIN_PIN } from './env'

// Builds a fresh throwaway shop database: two staff members (a cashier PIN
// and an admin PIN, for admin-gated flows like CSV import/export), one card
// with priced stock, default settings. Runs as the first half of the
// Playwright webServer command (see playwright.config.ts) so it always
// precedes the server boot — the libsql client opens the file eagerly at
// startup.
async function seed() {
  mkdirSync(dirname(E2E_DB_PATH), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(E2E_DB_PATH + suffix) } catch { /* first run */ }
  }
  const client = createClient({ url: `file:${E2E_DB_PATH}` })
  await applyMigrations(client)
  const db = drizzle(client, { schema })

  // All three games enabled so the game-first selector (GameFilter) renders
  // on every surface for the multi-game checkout spec (Task 12).
  await db.insert(schema.settings).values({ id: 1, enabledGames: JSON.stringify(['pokemon', 'mtg', 'yugioh']) })
  await db.insert(schema.staff).values({
    id: 1, name: 'Tess', pinHash: bcrypt.hashSync(STAFF_PIN, 4), role: 'staff',
  })
  await db.insert(schema.staff).values({
    id: 2, name: 'Priya', pinHash: bcrypt.hashSync(ADMIN_PIN, 4), role: 'admin',
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

  // MTG foil + YGO printing with priced stock (Task 12's multi-game
  // checkout). enabledGames above makes GameFilter render on every surface
  // for every spec in this shared seed, so these two names are chosen to
  // never collide with another spec's search terms ('Pikachu', the JA
  // card's 'リザードン'/'Charizard' alias, 'SV Booster Pack') or with a
  // GameFilter button's own label as a substring (notably 'Magic' — a name
  // like "Dark Magician" would make a card-name button match
  // getByRole('button', { name: 'Magic' })). sellPriceOverride makes both
  // sellable without a price_cache row, exactly like the JA card above.
  const [mtgCard] = await db.insert(schema.cards).values({
    name: 'Lightning Bolt', game: 'mtg', language: 'EN', variant: 'Foil',
    setName: 'Limited Edition Alpha', setNumber: '150', externalId: 'scryfall:foil:e2e-mtg-0001',
  }).returning()
  await db.insert(schema.inventoryItems).values({
    cardId: mtgCard.id, condition: 'NM', quantity: 2, costPrice: 400,
    sellPriceOverride: 1200, // £12.00
    qrCode: 'e2e-mtg-foil-qr',
  })

  const [ygoCard] = await db.insert(schema.cards).values({
    name: 'Blue-Eyes White Dragon', game: 'yugioh', language: 'EN', variant: 'Ultra Rare',
    setName: 'Legend of Blue Eyes White Dragon', setNumber: 'LOB-001', externalId: 'ygoprodeck:e2e-ygo-0001:Ultra Rare',
  }).returning()
  await db.insert(schema.inventoryItems).values({
    cardId: ygoCard.id, condition: 'NM', quantity: 5, costPrice: 150,
    sellPriceOverride: 350, // £3.50
    qrCode: 'e2e-ygo-printing-qr',
  })

  client.close()
  console.log(`e2e database seeded at ${E2E_DB_PATH}`)
}

seed().catch(e => { console.error(e); process.exit(1) })
