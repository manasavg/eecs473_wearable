import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Excursion",
    short_name: "Excursion",
    description: "LoRa check-in and UWB distance for the leader phone.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111111",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
