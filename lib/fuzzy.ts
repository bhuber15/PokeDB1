// Trigram similarity for catalogue name matching. Dependency-free and DB-free
// so it stays safe to import from client components (see AGENTS.md on the
// client-bundle boundary).

// Lowercase and strip everything but letters/digits so "Farfetch'd" and
// "farfetchd" (or stray spaces) compare equal.
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function trigrams(s: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3))
  return grams
}

// Sørensen–Dice coefficient over character trigrams of the normalized strings.
// 0 = nothing shared, 1 = identical. Misspellings that keep most of the word
// intact score well above unrelated names ("snorlex"/"snorlax" ≈ 0.6,
// "snorlex"/"pikachu" = 0). Strings shorter than one trigram can't be scored.
export function similarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return 1
  if (na.length < 3 || nb.length < 3) return 0
  const ta = trigrams(na)
  const tb = trigrams(nb)
  let shared = 0
  for (const g of ta) if (tb.has(g)) shared++
  return (2 * shared) / (ta.size + tb.size)
}
