'use client'
import { useSyncExternalStore } from 'react'

// Online tracker on useSyncExternalStore (same shape as useStickyGameFilter):
// the snapshot is navigator.onLine, re-read whenever the window online/offline
// events fire. The server snapshot is `true`, so SSR and hydration assume
// online and the browser corrects itself immediately after mount.
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
}
