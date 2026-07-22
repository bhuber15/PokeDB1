import pokedex from '@/lib/data/pokedex-en.json'

// EN species alias for a TCGdex dexId list. First id wins — TCGdex lists one
// species for regular cards; multi-species cards (tag teams) are rare enough
// that the first name is the useful search hook.
export function aliasForDexIds(dexIds: number[] | null | undefined): string | null {
  const id = dexIds?.[0]
  if (id == null) return null
  return (pokedex as Record<string, string>)[String(id)] ?? null
}
