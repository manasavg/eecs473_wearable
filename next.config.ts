import path from "node:path";
import type { NextConfig } from "next";

const capacitor = process.env.CAPACITOR === "1";
const utilShim = path.join(process.cwd(), "src/lib/polyfills/util-browser.cjs");

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        util: utilShim,
        "node:util": utilShim,
      };
    }
    return config;
  },
  ...(capacitor
    ? {
        output: "export" as const,
        images: { unoptimized: true },
        eslint: { ignoreDuringBuilds: true },
        // The typecheck worker can sit forever with no new output on macOS.
        experimental: { workerThreads: false, cpus: 1 },
      }
    : {}),
};

export default nextConfig;
