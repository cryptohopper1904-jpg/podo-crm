import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { LOGO_KINDS, loadLogo, type LogoKind } from "@/server/practice-logos";

/**
 * Logo der eigenen Praxis für Bögen/Druckansichten (nur angemeldete Mitglieder, keine Personendaten).
 * `?ersatz=1`: fehlt diese Art, wird die andere geliefert. Ohne Logo 404 (die Seite blendet das Bild dann aus).
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/praxis/logo/[kind]">) {
  const { kind } = await ctx.params;
  const auth = await getAuth();
  if (!auth) return new NextResponse("Kein Zugriff", { status: 403 });
  if (!LOGO_KINDS.includes(kind as LogoKind)) return new NextResponse("Nicht gefunden", { status: 404 });
  const logo = await loadLogo(auth.organization.id, kind as LogoKind, { fallback: req.nextUrl.searchParams.get("ersatz") === "1" });
  if (!logo) return new NextResponse("Nicht gefunden", { status: 404 });
  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      "Content-Type": logo.mime,
      "Content-Length": String(logo.bytes.length),
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
