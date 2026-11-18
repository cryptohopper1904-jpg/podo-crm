import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { log } from "@/lib/log";
import { testpaket302, type Gkv302Quelle } from "@/server/gkv302-export";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * § 302-Testpaket als ZIP (docs/GKV-302.md „Bedienung in PodoHero“). POST, weil Nummern (Test-Kreis) vergeben und ein
 * Audit-Eintrag geschrieben werden – damit greifen Nur-Lesen-Modus (schreibende Anfrage) und Support-Sperre.
 * Body: { "quelle": "bereit" | "<Abrechnungslauf-ID>" }. Nur gleiche Herkunft (fetch aus der App).
 */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !auth.can("invoices.write") || !auth.can("medical.read")) return NextResponse.json({ error: auth?.readOnly ? "Im Nur-Lesen-Modus können keine Dateien erzeugt werden." : "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "gkv302_test")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  // Schutz vor fremden Seiten (zusätzlich zu SameSite=Lax): nur Anfragen aus der App selbst
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 415 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  const q = body && typeof body === "object" ? (body as { quelle?: unknown }).quelle : undefined;
  let quelle: Gkv302Quelle;
  if (q === "bereit") quelle = { art: "bereit" };
  else if (typeof q === "string" && UUID.test(q)) quelle = { art: "lauf", batchId: q };
  else return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  try {
    const r = await testpaket302(auth, quelle);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 422, headers: { "Cache-Control": "private, no-store" } });
    return new NextResponse(Buffer.from(r.zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${r.dateiname}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    // keine Patientendaten im Log: nur Fehlerart
    log.error("gkv302.testdatei.failed", { error: e instanceof Error ? e.name : "unbekannt" });
    return NextResponse.json({ error: "Die Testdatei konnte nicht erzeugt werden." }, { status: 500 });
  }
}
