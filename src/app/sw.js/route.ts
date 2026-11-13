import { buildServiceWorker } from "@/lib/pwa/service-worker";

/**
 * Service Worker unter /sw.js (Scope „/“). Der Inhalt enthält die Build-Version (next.config.ts → PODO_APP_VERSION):
 * Jeder neue Build ist für den Browser eine neue SW-Version → Hinweis „Neue Version verfügbar“, alte Caches werden
 * beim Aktivieren gelöscht. Nie zwischenspeichern, damit Updates sofort erkannt werden.
 * Der Proxy (src/proxy.ts) lässt /sw.js ohne Sitzung durch; der Inhalt ist für alle gleich.
 */
/** Version steht beim Build fest (env aus next.config.ts) → statisch vorab erzeugen */
export const dynamic = "force-static";

export function GET() {
  return new Response(buildServiceWorker(process.env.PODO_APP_VERSION ?? "dev"), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
