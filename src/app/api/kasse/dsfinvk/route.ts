import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { createRateLimiter } from "@/lib/rate-limit";
import { buildDsfinvkExport, exportRangeInput, KasseError } from "@/server/kasse";

/** Höchstens 5 Exporte je Praxis und Minute */
const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 5_000 });

/** DSFinV-K-Export als ZIP für einen Zeitraum (?from=YYYY-MM-DD&to=YYYY-MM-DD), Recht invoices.read. */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("invoices.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  const parsed = exportRangeInput.safeParse({ from: req.nextUrl.searchParams.get("from"), to: req.nextUrl.searchParams.get("to") });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Zeitraum ungültig" }, { status: 400 });
  if (limiter.limited(`org:${auth.organization.id}`)) return NextResponse.json({ error: "Bitte kurz warten." }, { status: 429, headers: { "Retry-After": "60" } });
  try {
    const r = await buildDsfinvkExport(auth, parsed.data.from, parsed.data.to);
    return new NextResponse(Buffer.from(r.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof KasseError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
