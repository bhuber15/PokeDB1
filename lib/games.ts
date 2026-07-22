// Game and language constants shared by the import pipeline (server) and
// badges/filters (client) — keep this module dependency-free so it never
// drags the DB client into a browser bundle (see lib/adjustment-reasons.ts).
export const GAME_IDS = ['pokemon'] as const // phase 2 adds more games (spec §6)
export type Game = (typeof GAME_IDS)[number]

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
