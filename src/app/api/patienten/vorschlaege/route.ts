import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { cleanQuery } from "@/lib/patient-search";
import { suggestLimiter, suggestPatients } from "@/server/patient-search";

const headers = { "Cache-Control": "private, no-store" };

/**
 * GET /api/patienten/vorschlaege?q=<Suchtext>  → { hits, more, didYouMean }
 * Live-Suche der Kopfzeile. Nur mit Anmeldung und Recht „patients.read“ (wie die Patientenliste /kunden),
 * Praxis aus der Sitzung (withOrg), gedrosselt je Benutzer:in. Der Suchtext wird weder geloggt noch im Audit
 * gespeichert (siehe src/server/patient-search.ts); Support-Zugriffe protokolliert getAuth() als support.view.
 */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401, headers });
  if (!auth.can("patients.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403, headers });
  if (suggestLimiter.limited(`user:${auth.user.id}`)) {
    return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429, headers: { ...headers, "Retry-After": "30" } });
  }
  const q = cleanQuery(req.nextUrl.searchParams.get("q"));
  if (!q) return NextResponse.json({ hits: [], more: false, didYouMean: null }, { headers });
  return NextResponse.json(await suggestPatients(auth, q), { headers });
}
