import test from 'node:test'
import assert from 'node:assert/strict'
import { aliasForDexIds } from '@/lib/pokedex'

test('maps a dex id to the EN species name', () => {
  assert.equal(aliasForDexIds([6]), 'Charizard')
})

test('multi-species cards use the first id; unknown/empty → null', () => {
  assert.equal(aliasForDexIds([25, 26]), 'Pikachu')
  assert.equal(aliasForDexIds([999999]), null)
  assert.equal(aliasForDexIds(null), null)
  assert.equal(aliasForDexIds([]), null)
})

test('special names survive generation', () => {
  assert.equal(aliasForDexIds([122]), 'Mr. Mime')
  assert.equal(aliasForDexIds([250]), 'Ho-Oh')
})
