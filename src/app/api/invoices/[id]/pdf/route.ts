import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { invoicePdfForOrg, pdfResponseHeaders } from "@/server/invoice-delivery";

/** PDF einer ausgestellten Rechnung (Recht invoices.read). ?download=1 → als Datei speichern. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/invoices/[id]/pdf">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("invoices.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "invoice_pdf")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const pdf = await invoicePdfForOrg(auth.organization.id, id);
  if (!pdf) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "invoice.pdf", entity: "invoice", entityId: id });
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(pdf.bytes), { headers: pdfResponseHeaders(pdf.filename, disposition) });
}
