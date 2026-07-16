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
};

export default nextConfig;
