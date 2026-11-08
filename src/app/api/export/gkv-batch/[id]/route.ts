import { NextResponse, type NextRequest } from "next/server";
import { writeCsv } from "@/integrations/csv";
import { getAuth } from "@/lib/auth/session";
import { billingBatchExport } from "@/server/prescriptions";

/**
 * Abrechnungslauf als CSV in einem neutralen Format für ein Abrechnungszentrum.
 * Die Übermittlung nach § 302 SGB V übernimmt der Partner – dies ist KEIN §-302-Datensatz.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/export/gkv-batch/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("invoices.write")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const data = await billingBatchExport(auth, id);
  if (!data) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  return new NextResponse(writeCsv(data.lines), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gkv-abrechnung-${data.batch.createdAt.toISOString().slice(0, 10)}-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
