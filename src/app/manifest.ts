import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PodoCRM",
    short_name: "PodoCRM",
    description: "Praxis- und Kundensystem für Podologie",
    start_url: "/heute",
    display: "standalone",
    background_color: "#f4f9f8",
    theme_color: "#0b7f73",
    lang: "de",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
