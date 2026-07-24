'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { type Game } from '@/lib/games'

export type GameFilterValue = Game | 'all'

// A game selection that persists per surface for the browser session — a run of
// Magic buys stays on Magic without re-picking, but nothing leaks a hidden
// global mode across sessions. Starts on 'all'.
//
// Backed by sessionStorage through useSyncExternalStore: the server snapshot is
// always 'all' (no storage server-side, and it matches the pre-hydration
// render), while the client reads the stored value after hydration — so there
// is no setState-in-effect and no hydration mismatch. Writes notify same-tab
// subscribers via a custom event (sessionStorage's native 'storage' event only
// fires in *other* tabs, never the one that made the change).
const STORE_EVENT = 'pokedb:gameFilter'

export function useStickyGameFilter(surface: string): [GameFilterValue, (v: GameFilterValue) => void] {
  const key = `pokedb:gameFilter:${surface}`

  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener(STORE_EVENT, onStoreChange)
    return () => window.removeEventListener(STORE_EVENT, onStoreChange)
  }, [])

  const value = useSyncExternalStore<GameFilterValue>(
    subscribe,
    () => (sessionStorage.getItem(key) as GameFilterValue | null) ?? 'all',
    () => 'all',
  )

  const set = useCallback((v: GameFilterValue) => {
    sessionStorage.setItem(key, v)
    window.dispatchEvent(new Event(STORE_EVENT))
  }, [key])

  return [value, set]
}
