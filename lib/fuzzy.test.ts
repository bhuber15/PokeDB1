import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeName, similarity } from './fuzzy'

test('normalizeName lowercases and strips punctuation/spaces', () => {
  assert.equal(normalizeName("Farfetch'd"), 'farfetchd')
  assert.equal(normalizeName('Mr. Mime'), 'mrmime')
  assert.equal(normalizeName('PIKACHU'), 'pikachu')
})

test('similarity is 1 for names equal after normalization', () => {
  assert.equal(similarity('Snorlax', 'snorlax'), 1)
  assert.equal(similarity("Farfetch'd", 'farfetchd'), 1)
})

test('one-letter misspellings score above the unrelated-name range', () => {
  assert.ok(similarity('Snorlex', 'Snorlax') >= 0.4, 'snorlex/snorlax')
  assert.ok(similarity('Charzard', 'Charizard') >= 0.4, 'charzard/charizard')
  assert.ok(similarity('Snorlex', 'Pikachu') < 0.2, 'snorlex/pikachu')
  assert.ok(similarity('Charzard', 'Blastoise') < 0.2, 'charzard/blastoise')
})

test('strings shorter than one trigram score 0 unless identical', () => {
  assert.equal(similarity('ab', 'abcdef'), 0)
  assert.equal(similarity('ab', 'ab'), 1)
})
