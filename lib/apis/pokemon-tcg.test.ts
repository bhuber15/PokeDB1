import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { searchPokemonCards } from './pokemon-tcg'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

test('searchPokemonCards aborts a hung request after the timeout', async () => {
  // Fetch stub that never responds but honours the abort signal, like a
  // stalled upstream connection would.
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as typeof fetch

  const started = Date.now()
  await assert.rejects(
    searchPokemonCards('snorlax', 30, 50),
    (e: unknown) => e instanceof Error && e.name === 'TimeoutError',
  )
  assert.ok(Date.now() - started < 2000, 'should abort well before a real network timeout')
})

test('searchPokemonCards passes the timeout signal to fetch', async () => {
  let seenSignal: AbortSignal | undefined
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined
    return Promise.resolve(new Response(JSON.stringify({ data: [] })))
  }) as typeof fetch

  const cards = await searchPokemonCards('snorlax')
  assert.deepEqual(cards, [])
  assert.ok(seenSignal instanceof AbortSignal)
})

test('searchPokemonCards skips the network entirely for queries that strip to nothing', async () => {
  let called = false
  globalThis.fetch = (() => {
    called = true
    return Promise.resolve(new Response(JSON.stringify({ data: [] })))
  }) as typeof fetch

  const cards = await searchPokemonCards('"*?')
  assert.deepEqual(cards, [])
  assert.equal(called, false)
})
