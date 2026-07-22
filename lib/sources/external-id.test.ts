import test from 'node:test'
import assert from 'node:assert/strict'
import { tcgdexExternalId, parseExternalId } from '@/lib/sources/external-id'

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
