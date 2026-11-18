import { NextResponse, type NextRequest } from "next/server";
import { writeCsv } from "@/integrations/csv";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { neutralizeCsvRows } from "@/lib/csv-safe";
import { berlinDateIso } from "@/lib/format";
import { resolvePeriod } from "@/lib/stats";
import { belegliste, beleglisteRows } from "@/server/gkv-stats";

/**
 * Belegliste (GKV Paket C) als CSV: Zuzahlungsquittungen mit Stornobelegen und Abrechnungsläufe im Zeitraum (?von=&bis=).
 * Rechte: finance.read + invoices.read; im Support-Modus gesperrt.
 */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !auth.can("finance.read") || !auth.can("invoices.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "belegliste_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const period = resolvePeriod({ zeitraum: "frei", von: sp.get("von") ?? undefined, bis: sp.get("bis") ?? undefined }, berlinDateIso());
  const data = await belegliste(auth, period);
  const csv = writeCsv(neutralizeCsvRows(beleglisteRows(data)));
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="belegliste-${period.from}-bis-${period.until}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
