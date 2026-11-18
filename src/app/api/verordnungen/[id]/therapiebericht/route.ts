import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { therapyReportPdf } from "@/server/therapy-reports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Therapiebericht (Position 78530) als PDF für die Ärztin/den Arzt – Recht medical.read. ?download=1 → Datei. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/verordnungen/[id]/therapiebericht">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "gkv_document")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const pdf = await therapyReportPdf(auth, id);
  if (!pdf) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(pdf.bytes), { headers: pdfResponseHeaders(pdf.filename, disposition) });
}
