import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { getAuth } from "@/lib/auth/session";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { zBonPdfForOrg } from "@/server/kasse";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Z-Bon (Tagesabschluss) als PDF (Recht cash.read). ?download=1 → als Datei speichern. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/kasse/z-bon/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("cash.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const pdf = await zBonPdfForOrg(auth.organization.id, id);
  if (!pdf) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "kasse.z_bon_pdf", entity: "cash_closing", entityId: id });
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(pdf.bytes), { headers: pdfResponseHeaders(pdf.filename, disposition) });
}
