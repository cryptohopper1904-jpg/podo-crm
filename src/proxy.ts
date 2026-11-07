import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistische Prüfung: ohne Session-Cookie direkt zum Login.
 * Die echte Prüfung (Session gültig, Rolle, Mandant) passiert serverseitig in requireAuth().
 */
const PUBLIC = ["/login", "/einrichtung", "/api/webhooks", "/api/health", "/buchen", "/kein-zugriff"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/" || PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (!request.cookies.get("podo_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons|manifest.webmanifest|sw.js).*)"],
};
