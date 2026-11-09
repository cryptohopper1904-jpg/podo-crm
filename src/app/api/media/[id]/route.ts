import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { media } from "@/db/schema";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { readDecrypted } from "@/lib/storage";

/** Liefert eine entschlüsselte Datei aus – nur an berechtigte Nutzer der eigenen Praxis, nie gecacht. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("medical.read")) return new NextResponse("Kein Zugriff", { status: 403 });
  if (!downloadAllowed(auth, "media")) return new NextResponse(SUPPORT_DOWNLOAD_DENIED, { status: 403 });
  const org = auth.organization.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse("Nicht gefunden", { status: 404 });
  const [m] = await withOrg(org, (tx) => tx.select().from(media).where(and(eq(media.organizationId, org), eq(media.id, id), isNull(media.deletedAt))));
  if (!m) return new NextResponse("Nicht gefunden", { status: 404 });
  const data = await readDecrypted(m.storageKey);
  await audit({ organizationId: org, userId: auth.user.id, action: "media.read", entity: "media", entityId: id });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": m.mime,
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Nur Bilder inline; alles andere als Download. Sandbox verhindert Skriptausführung (z. B. in PDFs/SVG).
      "Content-Disposition": m.mime.startsWith("image/") ? "inline" : "attachment",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'",
    },
  });
}
