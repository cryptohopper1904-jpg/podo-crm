import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken } from "@/lib/auth/cookie";

/**
 * Optimistische Prüfung: ohne Session-Cookie direkt zum Login.
 * Die echte Prüfung (Session gültig, Rolle, Mandant) passiert serverseitig in requireAuth().
 */
const PUBLIC = ["/login", "/login/passwort-vergessen", "/login/passwort-neu", "/einrichtung", "/api/webhooks", "/api/calendar", "/api/health", "/api/cron", "/buchen", "/anamnese", "/portal", "/kein-zugriff", "/api/billing/webhook", "/api/voice",
  // Zusatzmodul Praxis-Website (/p/[slug]) – nur veröffentlichte Geschäftsangaben, keine Sitzung
  "/p",
  // Abmeldung von Vertriebsmails (HMAC-signiertes Token, keine Daten in der Antwort)
  "/abmelden",
  // Aktionsseite für Vertriebskampagnen (/aktion/[code]): nur Angebot gültiger Codes, neutral bei ungültigen, gedrosselt
  "/aktion",
  // öffentliche Website/Rechtstexte (src/app/(public)) – u. a. aus der Registrierung verlinkt
  "/agb", "/avv", "/datenschutz", "/impressum", "/preise", "/funktionen", "/sicherheit", "/unterauftragnehmer",
  // Vergleich, Wechsel-Ratgeber und Wissensbereich (statisch, ohne Praxisdaten)
  "/vergleich", "/wechseln", "/wissen",
  // SEO-Dateien der Website (src/app/robots.ts, src/app/sitemap.ts)
  "/robots.txt", "/sitemap.xml",
  // Installierbare Web-App: Offline-Hinweis (vom Service Worker ohne Cookies vorab geladen), Infoseite /app, Service Worker
  "/offline", "/app", "/sw.js"];

/** Methode/Pfad für requireAuth (Nur-Lesen-/Support-Modus, Audit) – überschreibt vom Client gesendete Werte. */
function next(request: NextRequest) {
  const h = new Headers(request.headers);
  h.set("x-podo-method", request.method);
  h.set("x-podo-path", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: h } });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/" || PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return next(request);
  }
  // Produktion: nur __Host-podo_session; Entwicklung: podo_session (siehe src/lib/auth/cookie.ts)
  if (!readSessionToken(request.cookies)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return next(request);
}

export const config = {
  // screenshots: Bildschirmfotos der Website mit Demodaten (public/screenshots) – statisch, ohne Sitzung
  // splash: iOS-Startbildschirme der installierten App (public/splash), sw.js: Service Worker
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|screenshots/|splash/|manifest.webmanifest|sw.js).*)"],
};
