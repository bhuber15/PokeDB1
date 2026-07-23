// One-off: generate lib/data/pokedex-en.json (dex id → EN species name) from
// PokeAPI. The JSON is committed — builds and imports never hit PokeAPI.
//   npx tsx scripts/generate-pokedex-aliases.ts
import { writeFileSync } from 'node:fs'

// Slug→display fixes where naive Title Case is wrong. Aliases are search
// data, so minor cosmetic misses beyond this list are acceptable.
const SPECIAL: Record<string, string> = {
  'mr-mime': 'Mr. Mime', 'mime-jr': 'Mime Jr.', 'mr-rime': 'Mr. Rime',
  farfetchd: "Farfetch'd", sirfetchd: "Sirfetch'd",
  'ho-oh': 'Ho-Oh', 'porygon-z': 'Porygon-Z',
  'jangmo-o': 'Jangmo-o', 'hakamo-o': 'Hakamo-o', 'kommo-o': 'Kommo-o',
  'nidoran-f': 'Nidoran♀', 'nidoran-m': 'Nidoran♂',
  'type-null': 'Type: Null', flabebe: 'Flabébé',
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

async function main() {
  const res = await fetch('https://pokeapi.co/api/v2/pokemon-species?limit=2000')
  if (!res.ok) throw new Error(`PokeAPI ${res.status}`)
  const { results } = await res.json() as { results: { name: string; url: string }[] }
  const out: Record<string, string> = {}
  for (const r of results) {
    // .../pokemon-species/6/ → 6
    const id = r.url.match(/\/(\d+)\/?$/)?.[1]
    if (!id) continue
    out[id] = SPECIAL[r.name] ?? r.name.split('-').map(cap).join(' ')
  }
  writeFileSync('lib/data/pokedex-en.json', JSON.stringify(out, null, 1) + '\n')
  console.log(`wrote ${Object.keys(out).length} species to lib/data/pokedex-en.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
