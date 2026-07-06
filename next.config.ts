import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.pokemontcg.io" },
      { protocol: "https", hostname: "assets.tcgdex.net" },
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
};

export default nextConfig;
