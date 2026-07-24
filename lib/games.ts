// Game and language constants shared by the import pipeline (server) and
// badges/filters (client) — keep this module dependency-free so it never
// drags the DB client into a browser bundle (see lib/adjustment-reasons.ts).
export const GAME_IDS = ['pokemon', 'mtg', 'yugioh'] as const
export type Game = (typeof GAME_IDS)[number]

export function isGame(x: unknown): x is Game {
  return typeof x === 'string' && (GAME_IDS as readonly string[]).includes(x)
}

// DB `cards.language` values. Uppercase, matching the existing 'EN' default.
export const LANGUAGES = ['EN', 'JA', 'KO', 'ZH-CN', 'ZH-TW'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<Language, string> = {
  EN: 'English',
  JA: 'Japanese',
  KO: 'Korean',
  'ZH-CN': 'Chinese (Simplified)',
  'ZH-TW': 'Chinese (Traditional)',
}

// Languages whose Pokémon catalogue comes from TCGdex (EN stays on
// pokemontcg.io), mapped to TCGdex URL path codes.
export const TCGDEX_LANGS: Record<Exclude<Language, 'EN'>, string> = {
  JA: 'ja',
  KO: 'ko',
  'ZH-CN': 'zh-cn',
  'ZH-TW': 'zh-tw',
}
export const NON_EN_LANGUAGES = Object.keys(TCGDEX_LANGS) as Exclude<Language, 'EN'>[]

export function isLanguage(x: unknown): x is Language {
  return typeof x === 'string' && (LANGUAGES as readonly string[]).includes(x)
}

export interface GameMeta {
  id: Game
  label: string       // full name for settings/labels
  shortLabel: string  // compact name for badges/chips
  hasCatalogue: boolean // false is reserved for phase-3 manual games (Topps/Panini)
  languages: Language[] // languages this game's catalogue is offered in
}

// Metadata for badges, the settings toggle, and the search selector. Keep this
// dependency-free — client components import it. Pokémon carries all five
// languages (phase 1); MTG/YGO are EN-only in phase 2.
export const GAMES: Record<Game, GameMeta> = {
  pokemon: { id: 'pokemon', label: 'Pokémon', shortLabel: 'Pokémon', hasCatalogue: true, languages: [...LANGUAGES] },
  mtg: { id: 'mtg', label: 'Magic: The Gathering', shortLabel: 'Magic', hasCatalogue: true, languages: ['EN'] },
  yugioh: { id: 'yugioh', label: 'Yu-Gi-Oh!', shortLabel: 'Yu-Gi-Oh!', hasCatalogue: true, languages: ['EN'] },
}
