import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCSV, parseCSV } from './csv'

test('toCSV: plain fields are joined with commas and CRLF rows', () => {
  const csv = toCSV(['a', 'b'], [['1', '2'], ['3', '4']])
  assert.equal(csv, 'a,b\r\n1,2\r\n3,4')
})

test('toCSV: quotes fields containing commas, quotes or newlines (RFC 4180)', () => {
  const csv = toCSV(['name'], [['Charizard, holo'], ['say "hi"'], ['line1\nline2']])
  assert.equal(csv, 'name\r\n"Charizard, holo"\r\n"say ""hi"""\r\n"line1\nline2"')
})

test('toCSV: neutralises formula injection on strings with a leading trigger', () => {
  for (const evil of ['=1+1', '+1', '-cmd', '@SUM(A1)', '=HYPERLINK("http://x")']) {
    const csv = toCSV(['note'], [[evil]])
    // Round-trip: the stored value is the original prefixed with an apostrophe,
    // so a spreadsheet renders it verbatim as text instead of evaluating it.
    const parsed = parseCSV(csv)
    assert.equal(parsed[1][0], `'${evil}`, `expected neutralised value for ${evil}`)
  }
})

test('toCSV: numeric fields are never prefixed (numeric columns stay numeric)', () => {
  // Negative money like -5 must remain the number -5, not text '-5.
  const csv = toCSV(['qty', 'delta'], [[3, -5]])
  assert.equal(csv, 'qty,delta\r\n3,-5')
})

test('toCSV: a leading tab or carriage return is also neutralised', () => {
  const csv = toCSV(['x'], [['\t=evil']])
  const cell = csv.split('\r\n')[1]
  assert.ok(cell.includes("'\t=evil"))
})

test('parseCSV: round-trips quoted fields, embedded commas and escaped quotes', () => {
  const rows = parseCSV('name,note\r\n"Charizard, holo","say ""hi"""\r\nPikachu,plain')
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Charizard, holo', 'say "hi"'],
    ['Pikachu', 'plain'],
  ])
})

test('parseCSV: drops fully blank trailing lines', () => {
  const rows = parseCSV('a,b\r\n1,2\r\n')
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']])
})
