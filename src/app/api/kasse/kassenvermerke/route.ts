import { NextResponse, type NextRequest } from "next/server";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { createRateLimiter } from "@/lib/rate-limit";
import { exportRangeInput, externalRegisterCsv, KasseError } from "@/server/kasse";

/** Höchstens 10 Exporte je Praxis und Minute */
const limiter = createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 5_000 });

/**
 * Kassenvermerke (eigene Praxiskasse) als CSV für einen Zeitraum (?from=YYYY-MM-DD&to=YYYY-MM-DD) – Abgleichhilfe zum
 * Z-Bon der Praxiskasse. Recht cash.export (wie DSFinV-K-Export); Daten nur der eigenen Praxis (withOrg/RLS).
 */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (!auth.can("cash.export")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "cash_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const parsed = exportRangeInput.safeParse({ from: req.nextUrl.searchParams.get("from"), to: req.nextUrl.searchParams.get("to") });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Zeitraum ungültig" }, { status: 400 });
  if (limiter.limited(`org:${auth.organization.id}`)) return NextResponse.json({ error: "Bitte kurz warten." }, { status: 429, headers: { "Retry-After": "60" } });
  try {
    const r = await externalRegisterCsv(auth, parsed.data.from, parsed.data.to);
    return new NextResponse(r.text, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof KasseError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
