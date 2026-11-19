import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { Readable } from "node:stream";
import { handoverPackageStream } from "@/server/gkv-handover";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Neutrales Übergabepaket eines Abrechnungslaufs (ZIP, GKV Paket E, docs/GKV-ABRECHNUNGSZENTRUM.md). Erster Abruf
 * erzeugt und archiviert es (SHA-256), jeder weitere liefert die archivierte Datei („Nachdruck“, Header X-Podo-Nachdruck) –
 * gestreamt, die Prüfsumme läuft beim Lesen mit (Abbruch bei Abweichung). Fachlich fehlende Dokumente: Header
 * X-Podo-Fehlende-Dokumente (Liste im LIESMICH).
 * Rechte wie der Abrechnungslauf (invoices.write + medical.read), im Support-Modus gesperrt.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/export/gkv-batch/[id]/paket">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("invoices.write") || !auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "gkv_handover")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) return NextResponse.json(blocked, { status: 403 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const pkg = await handoverPackageStream(auth, id);
  if (!pkg) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if ("error" in pkg) return NextResponse.json(pkg, { status: 409 });
  // Buffer ohne Kopie übergeben (liegt zur Laufzeit auf einem ArrayBuffer); Nachdruck als Stream
  const body = Buffer.isBuffer(pkg.body) ? (pkg.body as Uint8Array<ArrayBuffer>) : (Readable.toWeb(pkg.body) as ReadableStream<Uint8Array>);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(pkg.sizeBytes),
      "X-Podo-Fehlende-Dokumente": String(pkg.missingDocuments),
      "Content-Disposition": `attachment; filename="${pkg.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Podo-Sha256": pkg.sha256,
      ...(pkg.reprint ? { "X-Podo-Nachdruck": "1" } : {}),
    },
  });
}
