import { type Language, isLanguage } from '@/lib/games'

// Bare ids ("xy7-54") are grandfathered pokemontcg.io EN rows — never
// rewritten (the nightly sweep's onConflict targets them). New sources are
// namespaced: tcgdex:<lang>:<raw id, case preserved — TCGdex set ids are
// mixed-case ("SV4a") and we fetch with the id verbatim>.
export type ParsedExternalId =
  | { source: 'pokemontcg'; id: string }
  | { source: 'tcgdex'; language: Language; id: string }

export function tcgdexExternalId(language: Exclude<Language, 'EN'>, rawId: string): string {
  return `tcgdex:${language.toLowerCase()}:${rawId}`
}

export function parseExternalId(externalId: string): ParsedExternalId {
  if (externalId.startsWith('tcgdex:')) {
    const rest = externalId.slice('tcgdex:'.length)
    // Language codes may contain a hyphen but never a colon.
    const sep = rest.indexOf(':')
    if (sep > 0) {
      const language = rest.slice(0, sep).toUpperCase()
      const id = rest.slice(sep + 1)
      if (isLanguage(language) && id) return { source: 'tcgdex', language, id }
    }
  }
  return { source: 'pokemontcg', id: externalId }
}
