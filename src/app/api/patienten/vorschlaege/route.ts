import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { cleanQuery } from "@/lib/patient-search";
import { suggestLimiter, suggestPatients } from "@/server/patient-search";

const headers = { "Cache-Control": "private, no-store" };
/** Anfragekörper höchstens so viele Bytes (Suchtext ≤ 80 Zeichen) */
const MAX_BODY_BYTES = 1_024;

/** Körper lesen, aber nie mehr als `max` Bytes puffern (auch ohne/mit falscher Content-Length); null = zu groß */
async function readCapped(req: NextRequest, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

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
  const tooLarge = () => NextResponse.json({ error: "Anfrage zu groß" }, { status: 413, headers });
  // erst die angekündigte Länge, dann beim Lesen hart begrenzen (Content-Length kann fehlen oder falsch sein)
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return tooLarge();
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === null) return tooLarge();
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
