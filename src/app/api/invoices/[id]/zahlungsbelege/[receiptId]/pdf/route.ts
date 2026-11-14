import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { ArchiveIntegrityError, ArchivePendingError } from "@/server/document-archive";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { paymentReceiptPdfForOrg } from "@/server/payment-receipts";

/** Beleg über einen Zahlungseingang (archiviertes Original; Recht invoices.read). ?download=1 → als Datei speichern. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/invoices/[id]/zahlungsbelege/[receiptId]/pdf">) {
  const { id, receiptId } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("invoices.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "invoice_pdf")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  let pdf: Awaited<ReturnType<typeof paymentReceiptPdfForOrg>>;
  try {
    pdf = await paymentReceiptPdfForOrg(auth.organization.id, id, receiptId);
  } catch (e) {
    // beschädigtes/fehlendes Archiv: nie stillschweigend neu erzeugen, sondern melden (Details im Server-Log)
    if (e instanceof ArchivePendingError) return NextResponse.json({ error: e.message }, { status: 503, headers: { "Retry-After": "60" } });
    if (e instanceof ArchiveIntegrityError) return NextResponse.json({ error: e.message }, { status: 500 });
    throw e;
  }
  if (!pdf) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "payment_receipt.pdf", entity: "invoice", entityId: id, meta: { receipt: pdf.receipt.number, variant: pdf.variant } });
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new NextResponse(Buffer.from(pdf.bytes), { headers: pdfResponseHeaders(pdf.filename, disposition) });
}
