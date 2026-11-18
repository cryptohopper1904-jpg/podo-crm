import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { signatureImage } from "@/server/signatures";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bild einer Unterschrift (Leistungsnachweis) – nur Recht medical.read, nie im Support-Modus, nie gecacht. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/signaturen/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("medical.read")) return new NextResponse("Kein Zugriff", { status: 403 });
  if (!downloadAllowed(auth, "gkv_document")) return new NextResponse(SUPPORT_DOWNLOAD_DENIED, { status: 403 });
  if (!UUID.test(id)) return new NextResponse("Nicht gefunden", { status: 404 });
  const data = await signatureImage(auth, id);
  if (!data) return new NextResponse("Nicht gefunden", { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(data.length),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'",
    },
  });
}
