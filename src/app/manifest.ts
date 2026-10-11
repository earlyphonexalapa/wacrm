import type { MetadataRoute } from "next";

// Web app manifest — what makes wacrm installable as a phone app from the
// browser ("Add to Home Screen" on iPhone). No App Store involved: see
// docs/ios-app.md. Opens straight into the inbox, full screen, like
// WhatsApp Business.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/inbox",
    name: "wacrm",
    short_name: "wacrm",
    description: "Bandeja de WhatsApp de tu equipo.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
