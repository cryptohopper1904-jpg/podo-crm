import { NextResponse, type NextRequest } from "next/server";
import { writeCsv } from "@/integrations/csv";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { neutralizeCsvRows } from "@/lib/csv-safe";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { renderTripLogPdf } from "@/lib/routing/trip-pdf";
import { tripLogRows } from "@/lib/routing/trip-log";
import { canReadTripLog, listTripsMonth, tripLogHeader } from "@/server/trips";

/** Fahrtenbuch-Export eines Monats als CSV oder PDF (Ziele pseudonymisiert). Rechte: Termine lesen oder Finanzen. */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!canReadTripLog(auth)) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "trip_log_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const month = req.nextUrl.searchParams.get("monat") ?? "";
  const format = req.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "Monat ungültig" }, { status: 400 });
  const { trips, totals } = await listTripsMonth(auth, month);
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "trips.export", meta: { month, format, count: trips.length } });
  const filename = `fahrtenbuch-${month}.${format}`;
  if (format === "pdf") {
    const head = await tripLogHeader(auth.organization.id);
    const label = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));
    const bytes = await renderTripLogPdf({ ...head, monthLabel: label, trips, totals, createdAt: new Date() });
    return new NextResponse(Buffer.from(bytes), { headers: pdfResponseHeaders(filename, "attachment") });
  }
  return new NextResponse(writeCsv(neutralizeCsvRows(tripLogRows(trips))), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
