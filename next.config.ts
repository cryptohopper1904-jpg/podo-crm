import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  // worker-src/manifest-src: nur eigener Service Worker (/sw.js) und eigenes Manifest (installierbare Web-App)
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Kamera und Mikrofon nur für die eigene Seite (Fotodoku, Sprachbericht)
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
];

/**
 * Build-Version für den Service Worker (src/app/sw.js/route.ts): ändert sich mit jedem Build, damit installierte
 * Apps „Neue Version verfügbar“ anzeigen und alte Datei-Caches löschen. Wird beim Build fest eingesetzt.
 */
const appVersion = process.env.PODO_APP_VERSION || process.env.GIT_COMMIT || new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

const nextConfig: NextConfig = {
  env: { PODO_APP_VERSION: appVersion },
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@node-rs/argon2", "exceljs"],
  // Rechtstexte der Website (src/app/(public)/_content/legal-doc.tsx) werden zur Laufzeit gelesen
  outputFileTracingIncludes: { "/*": ["docs/legal/*.md"] },
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  // Tailwind CSS v4 über den Turbopack-Loader
  turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"] } } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Service Worker: nie aus dem HTTP-Cache, sonst bleiben Updates hängen
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      // Einmal-Token im Pfad: nie als Referrer weitergeben, nicht cachen (spätere Regel überschreibt)
      { source: "/anamnese/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      // Abmeldelink der Vertriebsmails: Token nie als Referrer weitergeben, nicht cachen
      { source: "/abmelden/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      // Kundenportal: keine Referrer (persönlicher Link darf nicht an Dritte gelangen), nicht cachen
      { source: "/portal", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
      { source: "/portal/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
