import type { NextConfig } from "next";

const capacitor = process.env.CAPACITOR === "1";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
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
