import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { ArchiveIntegrityError, ArchivePendingError } from "@/server/document-archive";
import { invoicePdfForOrg, pdfResponseHeaders } from "@/server/invoice-delivery";

/**
 * PDF einer ausgestellten Rechnung (Recht invoices.read): archiviertes Original; stornierte Rechnung als Neudruck mit
 * Stornovermerk (?original=1 → archiviertes Original); Altbeleg ohne Archiv als Reproduktion. ?download=1 → als Datei.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/invoices/[id]/pdf">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("invoices.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "invoice_pdf")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  let pdf: Awaited<ReturnType<typeof invoicePdfForOrg>>;
  try {
    pdf = await invoicePdfForOrg(auth.organization.id, id, { original: req.nextUrl.searchParams.get("original") === "1" });
  } catch (e) {
    // beschädigtes/fehlendes Archiv: nie stillschweigend neu erzeugen, sondern melden (Details im Server-Log)
    if (e instanceof ArchivePendingError) return NextResponse.json({ error: e.message }, { status: 503, headers: { "Retry-After": "60" } });
    if (e instanceof ArchiveIntegrityError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }
  if (!pdf) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "invoice.pdf", entity: "invoice", entityId: id, meta: { variant: pdf.variant } });
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(pdf.bytes), { headers: pdfResponseHeaders(pdf.filename, disposition) });
}
