'use client'
import { createContext, useContext } from 'react'

// Minimal session facts the client UI may branch on (e.g. hiding the
// admin-only cost column). Server routes stay the real gate — this only
// controls what is rendered, never what is reachable.
export interface SessionInfo {
  staffRole?: 'admin' | 'staff'
}

const SessionContext = createContext<SessionInfo | null>(null)

export function SessionProvider({ value, children }: { value: SessionInfo; children: React.ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

// Least-privilege fallback: outside the provider, behave as plain staff.
export function useStaffRole(): 'admin' | 'staff' {
  return useContext(SessionContext)?.staffRole === 'admin' ? 'admin' : 'staff'
}
