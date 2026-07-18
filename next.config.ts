import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.pokemontcg.io" },
      { protocol: "https", hostname: "assets.tcgdex.net" },
      { protocol: "https", hostname: "images.scrydex.com" },
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
