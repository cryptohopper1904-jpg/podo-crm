import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { cleanQuery } from "@/lib/patient-search";
import { suggestLimiter, suggestPatients } from "@/server/patient-search";

const headers = { "Cache-Control": "private, no-store" };
/** Anfragekörper höchstens so groß (Suchtext ≤ 80 Zeichen) */
const MAX_BODY = 1_024;

/**
 * POST /api/patienten/vorschlaege  { q: <Suchtext> }  → { hits, more, didYouMean }
 * Live-Suche der Kopfzeile. POST statt GET, damit der Suchtext nicht in URL/Proxy-Logs landet.
 * Nur mit Anmeldung und Recht „patients.read“ (wie die Patientenliste /kunden), Praxis aus der Sitzung (withOrg),
 * gedrosselt je Benutzer:in. Der Suchtext wird weder geloggt noch im Audit gespeichert
 * (siehe src/server/patient-search.ts). Gilt trotz POST als Lesezugriff (src/lib/auth/read-requests.ts): funktioniert
 * mit Support-Freigabe „read“ und im Nur-Lesen-Modus; getAuth() protokolliert support.view entprellt als „read“.
 */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401, headers });
  if (!auth.can("patients.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403, headers });
  if (suggestLimiter.limited(`user:${auth.user.id}`)) {
    return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429, headers: { ...headers, "Retry-After": "30" } });
  }
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return NextResponse.json({ error: "JSON erwartet" }, { status: 415, headers });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Anfrage zu groß" }, { status: 413, headers });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400, headers });
  }
  const q = cleanQuery(body && typeof body === "object" ? (body as { q?: unknown }).q : null);
  if (!q) return NextResponse.json({ hits: [], more: false, didYouMean: null }, { headers });
  return NextResponse.json(await suggestPatients(auth, q), { headers });
}
