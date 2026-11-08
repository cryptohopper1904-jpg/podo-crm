import { NextResponse, type NextRequest } from "next/server";
import { requestMeta } from "@/lib/auth/session";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { portalFailLimiter, portalInvoicePdf, portalLimiter, resolvePortalLink } from "@/server/portal-core";

/** Rechnungs-PDF im Kundenportal – nur, wenn die Rechnung zur Person des Links gehört. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/portal/[token]/rechnung/[id]">) {
  const { token, id } = await ctx.params;
  const ip = (await requestMeta()).ip ?? "unbekannt";
  if (portalFailLimiter.exceeded(ip) || portalLimiter.limited(`pdf:${ip}`)) return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429 });
  const link = await resolvePortalLink(token);
  const pdf = link ? await portalInvoicePdf(link, id) : null;
  if (!pdf) {
    portalFailLimiter.limited(ip);
    return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  }
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { ...pdfResponseHeaders(pdf.filename, "attachment"), "Referrer-Policy": "no-referrer" } });
}
