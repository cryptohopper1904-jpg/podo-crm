import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/rate-limit";
import type { HandoverError } from "@/server/gkv-handover";

/** Downloads des Übergabepakets bzw. der CSV: höchstens 5 je Praxis und Minute (AppSec M1, wie DSFinV-K) */
const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 5_000 });

/**
 * Gemeinsame Vorprüfung der Übergabe-Routen: Anfragen von fremden Seiten (Sec-Fetch-Site: cross-site) ablehnen – fehlt
 * der Header (ältere Clients), zulassen (AppSec M2) – und Rate-Limit je Praxis.
 */
export function handoverPreflight(req: NextRequest, orgId: string): NextResponse | null {
  // POST (Erst-Export, unumkehrbar) nur von der eigenen Seite; GET (Nachdruck) auch per direkter Navigation („none“).
  // Fehlt der Header (ältere Browser), schützt SameSite=Lax gegen fremde Seiten.
  const site = req.headers.get("sec-fetch-site");
  const allowed = req.method === "POST" ? ["same-origin"] : ["same-origin", "none"];
  if (site && !allowed.includes(site)) return NextResponse.json({ error: "Anfrage von einer fremden Seite abgelehnt." }, { status: 403 });
  if (limiter.limited(`org:${orgId}`)) return NextResponse.json({ error: "Bitte kurz warten." }, { status: 429, headers: { "Retry-After": "60" } });
  return null;
}

/** Fehler des Übergabepakets → HTTP: ausgelastet 429, noch nicht erzeugt bzw. sonst 409 */
export function handoverErrorResponse(e: HandoverError): NextResponse {
  if (e.busy) return NextResponse.json({ error: e.error }, { status: 429, headers: { "Retry-After": "60" } });
  return NextResponse.json({ error: e.error }, { status: 409 });
}
