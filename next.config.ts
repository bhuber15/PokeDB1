import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Skip Next's Image Optimization API for card art: Scryfall (Magic) sits
    // behind Cloudflare, which bot-blocks the optimizer's server-side fetch
    // (undici gets 400, browsers get 200) — that broke every Magic image. The
    // source CDNs already serve small thumbnails, so we load them directly.
    unoptimized: true,
    // Retained so per-host optimization can be re-enabled later if desired.
    remotePatterns: [
      { protocol: "https", hostname: "images.pokemontcg.io" },
      { protocol: "https", hostname: "assets.tcgdex.net" },
      { protocol: "https", hostname: "images.scrydex.com" },
      { protocol: "https", hostname: "cards.scryfall.io" }, // Magic: The Gathering (Scryfall)
      { protocol: "https", hostname: "images.ygoprodeck.com" }, // Yu-Gi-Oh! (YGOPRODeck)
    ],
  },
  async redirects() {
    return [
      {
        source: "/wants",
        destination: "/customers?view=wants",
        permanent: false,
      },
    ];
  },
  // provisionTenant() applies lib/db/migrations/*.sql at runtime (Stripe
  // webhook); static tracing can't see the dynamic readFileSync paths.
  outputFileTracingIncludes: {
    '/api/platform/stripe': ['./lib/db/migrations/**/*'],
  },
  // Pin the workspace root: in a git worktree Next would otherwise walk up,
  // find the parent checkout's lockfile, and scan the whole parent tree —
  // slow enough to flake the e2e's first-compile assertions.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
