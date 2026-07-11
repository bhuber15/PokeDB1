// Single point of change for the product rename (see
// docs/superpowers/specs/2026-07-11-saas-platform-architecture.md §3.11).
// Client-safe: no imports, reads only NEXT_PUBLIC_ env (inlined at build).
export const BRAND = {
  // Shop-facing product name. Defaults to the working title until the
  // trademark-checked name is chosen; then one env var renames everything.
  name: process.env.NEXT_PUBLIC_BRAND_NAME || 'PokeDB',
  productName: `${process.env.NEXT_PUBLIC_BRAND_NAME || 'PokeDB'} — Card Shop POS`,
  supportEmail: process.env.NEXT_PUBLIC_BRAND_SUPPORT_EMAIL || 'support@example.com',
} as const
