import { Badge } from '@/components/ui/badge'
import { GAMES, type Game } from '@/lib/games'

// Renders a compact game badge for non-Pokémon cards; nothing for Pokémon (the
// baseline game needs no badge). Used beside the language badge on every card
// result surface so an "All games" result list is unambiguous.
export function GameBadge({ game }: { game: Game | string | null | undefined }) {
  if (!game || game === 'pokemon') return null
  return <Badge variant="outline">{GAMES[game as Game]?.shortLabel ?? game}</Badge>
}
