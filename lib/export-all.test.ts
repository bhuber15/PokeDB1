import { test } from 'node:test'
import assert from 'node:assert'
import { unzipSync, strFromU8 } from 'fflate'
import { createTestDb, seedBase } from '@/lib/db/test-helpers'
import { cards } from '@/lib/db/schema'
import { buildFullExport } from './export-all'

test('exports one CSV per table plus a manifest, with formula injection defused', async () => {
  const db = await createTestDb()
  await seedBase(db)
  await db.insert(cards).values({ id: 2, name: '=HYPERLINK("evil")', setName: 'Base', setNumber: '4/102' })

  const { zip, manifest } = await buildFullExport(db, new Date('2026-07-18T12:00:00Z'))
  const files = unzipSync(zip)

  assert.ok(files['manifest.json'])
  assert.ok(files['cards.csv'])
  assert.ok(files['settings.csv'])
  assert.ok(files['sales.csv'])

  const parsed = JSON.parse(strFromU8(files['manifest.json']))
  assert.equal(parsed.exportedAt, '2026-07-18T12:00:00.000Z')
  assert.equal(parsed.tables.cards, 2)          // seedBase card + the hostile one
  assert.equal(parsed.tables.settings, 1)
  assert.equal(parsed.tables.cards, manifest.tables.cards)

  const cardsCsv = strFromU8(files['cards.csv'])
  assert.ok(cardsCsv.split('\r\n')[0].includes('name'))          // header row = column names
  assert.ok(cardsCsv.includes(`"'=HYPERLINK(""evil"")"`))        // lib/csv formula guard applied
})

test('empty tables still get a header-only CSV (schema is part of the export)', async () => {
  const db = await createTestDb()
  await seedBase(db)
  const { zip, manifest } = await buildFullExport(db)
  const files = unzipSync(zip)
  assert.equal(manifest.tables.refunds, 0)
  const refundsCsv = strFromU8(files['refunds.csv'])
  assert.ok(refundsCsv.length > 0)
  assert.equal(refundsCsv.split('\r\n').length, 1)   // header only
})
