import { type Language, isLanguage } from '@/lib/games'

export type MtgFinish = 'nonfoil' | 'foil' | 'etched'

// Bare ids ("xy7-54") are grandfathered pokemontcg.io EN rows — never
// rewritten. New sources are namespaced:
//   tcgdex:<lang>:<raw id>                          (phase 1)
//   scryfall:<uuid>[:foil|:etched]                  (MTG; nonfoil has no suffix)
//   ygoprodeck:<passcode>:<set_code>:<rarity_slug>  (YGO; one row per printing)
export type ParsedExternalId =
  | { source: 'pokemontcg'; id: string }
  | { source: 'tcgdex'; language: Language; id: string }
  | { source: 'scryfall'; id: string; finish: MtgFinish }
  | { source: 'ygoprodeck'; passcode: string; setCode: string; rarity: string; id: string }

export function tcgdexExternalId(language: Exclude<Language, 'EN'>, rawId: string): string {
  return `tcgdex:${language.toLowerCase()}:${rawId}`
}

export function scryfallExternalId(uuid: string, finish: MtgFinish): string {
  return finish === 'nonfoil' ? `scryfall:${uuid}` : `scryfall:${uuid}:${finish}`
}

// Rarity codes carry parens ("(UR)") that mustn't reach an id; keep alnum only.
export function raritySlug(rarityCode: string): string {
  return rarityCode.replace(/[^a-zA-Z0-9]/g, '')
}

// ~1,400 YGOPRODeck printings have an empty set_rarity_code, which would yield
// a trailing-colon id ("ygoprodeck:1:X-1:") that parseExternalId rejects. Fall
// back to the rarity *name*, then a literal 'NA', so the rarity segment is
// always present and the id round-trips.
export function ygoExternalId(passcode: string, setCode: string, rarityCode: string, rarityName = ''): string {
  const slug = raritySlug(rarityCode) || raritySlug(rarityName) || 'NA'
  return `ygoprodeck:${passcode}:${setCode}:${slug}`
}

export function parseExternalId(externalId: string): ParsedExternalId {
  if (externalId.startsWith('tcgdex:')) {
    const rest = externalId.slice('tcgdex:'.length)
    const sep = rest.indexOf(':') // language codes may contain a hyphen, never a colon
    if (sep > 0) {
      const language = rest.slice(0, sep).toUpperCase()
      const id = rest.slice(sep + 1)
      if (isLanguage(language) && id) return { source: 'tcgdex', language, id }
    }
  }
  if (externalId.startsWith('scryfall:')) {
    const rest = externalId.slice('scryfall:'.length)
    const sep = rest.lastIndexOf(':')
    if (sep > 0) {
      const suffix = rest.slice(sep + 1)
      if (suffix === 'foil' || suffix === 'etched') {
        return { source: 'scryfall', id: rest.slice(0, sep), finish: suffix }
      }
    }
    if (rest) return { source: 'scryfall', id: rest, finish: 'nonfoil' }
  }
  if (externalId.startsWith('ygoprodeck:')) {
    const [passcode, setCode, rarity] = externalId.slice('ygoprodeck:'.length).split(':')
    if (passcode && setCode && rarity) {
      return { source: 'ygoprodeck', passcode, setCode, rarity, id: externalId }
    }
  }
  return { source: 'pokemontcg', id: externalId }
}
