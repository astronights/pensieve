import type { MetadataRoute } from "next";

/** Makes Pensieve installable as an app (Android: Chrome menu → Install app / Add to Home screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Pensieve",
    short_name: "Pensieve",
    description: "Flashcards",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#fafaf9",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
