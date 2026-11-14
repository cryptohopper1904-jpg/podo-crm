import "server-only";
import { NextResponse, type NextRequest } from "next/server";

/** Sekunden bis zum nächsten Versuch (Retry-After und automatisches Neuladen der Hinweisseite) */
export const ARCHIVE_RETRY_AFTER_S = 60;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Antwort, wenn das PDF eines Belegs (noch) nicht archiviert ist (ArchivePendingError): HTTP 503 mit Retry-After.
 * Ein Browser, der den PDF-Link öffnet (Accept: text/html), bekommt statt roher JSON-Daten eine kurze Hinweisseite
 * mit „Erneut versuchen“ (lädt nach Retry-After auch selbst neu); andere Aufrufer weiterhin JSON.
 */
export function archivePendingResponse(req: NextRequest, message: string, headers: Record<string, string> = {}) {
  const h = { ...headers, "Retry-After": String(ARCHIVE_RETRY_AFTER_S), "Cache-Control": "no-store" };
  if (!(req.headers.get("accept") ?? "").includes("text/html")) return NextResponse.json({ error: message }, { status: 503, headers: h });
  // nur Pfad + Abfrage dieser Anfrage (relativ, kein fremdes Ziel)
  const again = esc(`${req.nextUrl.pathname}${req.nextUrl.search}`);
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="${ARCHIVE_RETRY_AFTER_S}">
<title>PDF wird erzeugt</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9; color: #1b1f24; }
  main { max-width: 32rem; margin: 1rem; padding: 1.5rem; border-radius: 16px; background: #fff; border: 1px solid #dde1e6; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; margin-top: .75rem; border-radius: 12px; background: #0f5c8c; color: #fff; font-weight: 600; text-decoration: none; }
  @media (prefers-color-scheme: dark) { body { background: #111418; color: #e8eaed; } main { background: #1a1e23; border-color: #2c323a; } a { background: #3a8fc4; color: #0b0d10; } }
</style>
</head>
<body>
<main role="alert">
<h1>PDF wird erzeugt</h1>
<p>${esc(message)}</p>
<a href="${again}">Erneut versuchen</a>
</main>
</body>
</html>`;
  return new NextResponse(html, { status: 503, headers: { ...h, "Content-Type": "text/html; charset=utf-8" } });
}
