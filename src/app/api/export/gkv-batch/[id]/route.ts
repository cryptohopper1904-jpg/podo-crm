import { NextResponse, type NextRequest } from "next/server";
import { writeCsv } from "@/integrations/csv";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { billingBatchExport } from "@/server/prescriptions";
import { berlinDateIso } from "@/lib/format";

/**
 * Abrechnungslauf als CSV in einem neutralen Format für ein Abrechnungszentrum.
 * Die Übermittlung nach § 302 SGB V übernimmt der Partner – dies ist KEIN §-302-Datensatz.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/export/gkv-batch/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("invoices.write") || !auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "billing_batch_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) return NextResponse.json(blocked, { status: 403 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const data = await billingBatchExport(auth, id);
  if (!data) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  return new NextResponse(writeCsv(data.lines), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gkv-abrechnung-${berlinDateIso(data.batch.createdAt)}-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
