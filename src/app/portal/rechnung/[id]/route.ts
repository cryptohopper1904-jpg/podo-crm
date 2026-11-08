import { NextResponse, type NextRequest } from "next/server";
import { requestMeta } from "@/lib/auth/session";
import { clientKey } from "@/lib/rate-limit";
import { pdfResponseHeaders } from "@/server/invoice-delivery";
import { currentPortalLink, portalFailLimiter, portalInvoicePdf, portalLimiter } from "@/server/portal-core";

/** Rechnungs-PDF im Kundenportal (Sitzungs-Cookie) – nur, wenn die Rechnung zur Person des Links gehört. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/portal/rechnung/[id]">) {
  const { id } = await ctx.params;
  const key = clientKey(await requestMeta());
  const headers = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`pdf:${key}`)) return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429, headers });
  const link = await currentPortalLink();
  if (!link) return NextResponse.json({ error: "Sitzung abgelaufen – bitte den Link aus Ihrer Nachricht erneut öffnen." }, { status: 401, headers });
  const pdf = await portalInvoicePdf(link, id);
  if (!pdf) {
    portalFailLimiter.limited(key);
    return NextResponse.json({ error: "Nicht gefunden" }, { status: 404, headers });
  }
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { ...pdfResponseHeaders(pdf.filename, "attachment"), ...headers } });
}
