import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { followUpDocument } from "@/server/follow-ups";
import { pdfResponseHeaders } from "@/server/invoice-delivery";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Vorlage „Anforderung Folgeverordnung“ (PDF; ?format=text → Textdatei) – Recht medical.read. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/verordnungen/[id]/folgeverordnung">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "gkv_document")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const format = req.nextUrl.searchParams.get("format") === "text" ? "text" : "pdf";
  const doc = await followUpDocument(auth, id, format);
  if (!doc) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (format === "text") {
    return new NextResponse(Buffer.from(doc.bytes), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${doc.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(doc.bytes), { headers: pdfResponseHeaders(doc.filename, disposition) });
}
