import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { handoverCsv } from "@/server/gkv-handover";
import { handoverErrorResponse, handoverPreflight } from "../guard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abrechnungslauf als CSV (neutrales Format, „verordnungen.csv“ des Übergabepakets, GKV Paket E) – nur aus dem Archiv
 * (byte-gleich). Ohne Archiv 409: Der Erst-Export, der den Lauf übergibt, läuft nur per POST auf …/paket (AppSec M2).
 * Cross-Site abgelehnt, Rate-Limit je Praxis.
 * Die Übermittlung nach § 302 SGB V übernimmt der Partner – dies ist KEIN §-302-Datensatz.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/export/gkv-batch/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("invoices.write") || !auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "billing_batch_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) return NextResponse.json(blocked, { status: 403 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const pre = handoverPreflight(req, auth.organization.id);
  if (pre) return pre;
  const data = await handoverCsv(auth, id, { create: false });
  if (!data) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if ("error" in data) return handoverErrorResponse(data);
  return new NextResponse(data.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${data.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(data.reprint ? { "X-Podo-Nachdruck": "1" } : {}),
    },
  });
}
