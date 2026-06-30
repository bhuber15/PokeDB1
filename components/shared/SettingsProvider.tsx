'use client'
import { createContext, useContext } from 'react'
import type { AppSettings } from '@/lib/settings'

const SettingsContext = createContext<AppSettings | null>(null)

export function SettingsProvider({ value, children }: { value: AppSettings; children: React.ReactNode }) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): AppSettings {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    // Fallback so components never crash if used outside the provider
    return { shopName: 'PokeDB', usdToGbp: 0.79, marginMultiplier: 0.85, highValueThreshold: 50 }
  }
  return ctx
}
