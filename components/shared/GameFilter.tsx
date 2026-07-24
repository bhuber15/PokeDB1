'use client'
import { useSettings } from '@/components/shared/SettingsProvider'
import { GAMES, type Game } from '@/lib/games'
import type { GameFilterValue } from '@/components/shared/useStickyGameFilter'

// Game-first search scope. Single-select ("All games" or one game). Renders
// only when the shop has more than one game enabled, so single-game shops see
// no new chrome. Segmented buttons for a handful of games.
export function GameFilter({ value, onChange }: { value: GameFilterValue; onChange: (v: GameFilterValue) => void }) {
  const { enabledGames } = useSettings()
  if (enabledGames.length <= 1) return null
  const options: GameFilterValue[] = ['all', ...enabledGames]
  return (
    <div role="group" aria-label="Filter by game" className="inline-flex rounded-md border bg-muted p-0.5">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-sm rounded ${value === opt ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          {opt === 'all' ? 'All games' : GAMES[opt as Game].shortLabel}
        </button>
      ))}
    </div>
  )
}
