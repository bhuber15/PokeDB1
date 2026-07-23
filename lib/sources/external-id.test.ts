import test from 'node:test'
import assert from 'node:assert/strict'
import { tcgdexExternalId, parseExternalId, scryfallExternalId, ygoExternalId, raritySlug } from '@/lib/sources/external-id'

test('bare ids parse as pokemontcg (grandfathered EN rows)', () => {
  assert.deepEqual(parseExternalId('xy7-54'), { source: 'pokemontcg', id: 'xy7-54' })
})

test('tcgdex ids round-trip with case preserved on the raw id', () => {
  const ext = tcgdexExternalId('JA', 'SV4a-006')
  assert.equal(ext, 'tcgdex:ja:SV4a-006')
  assert.deepEqual(parseExternalId(ext), { source: 'tcgdex', language: 'JA', id: 'SV4a-006' })
})

test('zh-cn code (contains a hyphen) round-trips', () => {
  assert.deepEqual(parseExternalId(tcgdexExternalId('ZH-CN', 'abc-1')),
    { source: 'tcgdex', language: 'ZH-CN', id: 'abc-1' })
})

test('malformed tcgdex prefix falls back to pokemontcg parse', () => {
  assert.deepEqual(parseExternalId('tcgdex:xx:foo'), { source: 'pokemontcg', id: 'tcgdex:xx:foo' })
})

test('scryfall nonfoil id has no finish suffix and parses back', () => {
  const ext = scryfallExternalId('4cbc6901-6a4a-4d0a-83ea-7eefa3b35021', 'nonfoil')
  assert.equal(ext, 'scryfall:4cbc6901-6a4a-4d0a-83ea-7eefa3b35021')
  assert.deepEqual(parseExternalId(ext), { source: 'scryfall', id: '4cbc6901-6a4a-4d0a-83ea-7eefa3b35021', finish: 'nonfoil' })
})

test('scryfall foil/etched ids carry the finish suffix', () => {
  assert.equal(scryfallExternalId('abc', 'foil'), 'scryfall:abc:foil')
  assert.deepEqual(parseExternalId('scryfall:abc:foil'), { source: 'scryfall', id: 'abc', finish: 'foil' })
  assert.deepEqual(parseExternalId('scryfall:abc:etched'), { source: 'scryfall', id: 'abc', finish: 'etched' })
})

test('ygoprodeck ids encode passcode, set code and a paren-free rarity slug', () => {
  const ext = ygoExternalId('46986414', 'CT13-EN003', '(UR)')
  assert.equal(ext, 'ygoprodeck:46986414:CT13-EN003:UR')
  assert.deepEqual(parseExternalId(ext), {
    source: 'ygoprodeck', passcode: '46986414', setCode: 'CT13-EN003', rarity: 'UR', id: ext,
  })
})

test('empty rarity code falls back to the rarity name, then NA — and still round-trips', () => {
  assert.equal(ygoExternalId('1', 'X-1', '', 'Ultra Rare'), 'ygoprodeck:1:X-1:UltraRare')
  const na = ygoExternalId('1', 'X-1', '', '')
  assert.equal(na, 'ygoprodeck:1:X-1:NA')
  assert.deepEqual(parseExternalId(na), { source: 'ygoprodeck', passcode: '1', setCode: 'X-1', rarity: 'NA', id: na })
})

test('raritySlug strips non-alphanumerics', () => {
  assert.equal(raritySlug('(UR)'), 'UR')
  assert.equal(raritySlug('Secret Rare'), 'SecretRare')
})

test('unknown prefixes still fall back to a grandfathered pokemontcg parse', () => {
  assert.deepEqual(parseExternalId('xy7-54'), { source: 'pokemontcg', id: 'xy7-54' })
})
