import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { handoverPackage } from "@/server/gkv-handover";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Neutrales Übergabepaket eines Abrechnungslaufs (ZIP, GKV Paket E, docs/GKV-ABRECHNUNGSZENTRUM.md). Erster Abruf
 * erzeugt und archiviert es (SHA-256), jeder weitere liefert die archivierte Datei („Nachdruck“, Header X-Podo-Nachdruck).
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
  const pkg = await handoverPackage(auth, id);
  if (!pkg) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if ("error" in pkg) return NextResponse.json(pkg, { status: 500 });
  return new NextResponse(new Uint8Array(pkg.bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${pkg.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Podo-Sha256": pkg.sha256,
      ...(pkg.reprint ? { "X-Podo-Nachdruck": "1" } : {}),
    },
  });
}
