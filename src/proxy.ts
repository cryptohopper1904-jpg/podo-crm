import { NextResponse, type NextRequest } from "next/server";
import { readSessionToken } from "@/lib/auth/cookie";

/**
 * Optimistische Prüfung: ohne Session-Cookie direkt zum Login.
 * Die echte Prüfung (Session gültig, Rolle, Mandant) passiert serverseitig in requireAuth().
 */
const PUBLIC = ["/login", "/einrichtung", "/api/webhooks", "/api/calendar", "/api/health", "/api/cron", "/buchen", "/anamnese", "/portal", "/kein-zugriff", "/api/billing/webhook", "/api/voice",
  // öffentliche Website/Rechtstexte (src/app/(public)) – u. a. aus der Registrierung verlinkt
  "/agb", "/avv", "/datenschutz", "/impressum", "/preise", "/funktionen", "/sicherheit", "/unterauftragnehmer"];

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons|manifest.webmanifest|sw.js).*)"],
};
