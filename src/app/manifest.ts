import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Excursion Leader",
    short_name: "Excursion",
    description:
      "Leader beacon dashboard for the Guided Excursion Wearable. Distance, direction, and check-ins without cell service.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f0e6",
    theme_color: "#234037",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
