import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { normalizeBatchCode } from "@/lib/hygiene-rules";
import { BATCH_CODE_RE, batchStatus } from "@/server/hygiene";

/**
 * Status einer Sterilgut-Charge für den Hinweis im Doku-Formular.
 * Antwort: { code, ok, reason: null|"unknown"|"rejected"|"pending"|"expired", message, result, expiresAt }
 * Enthält keine Patientendaten.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/hygiene/batch/[code]">) {
  const auth = await getAuth();
  if (!auth || !auth.can("medical.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  const { code: raw } = await ctx.params;
  let code: string;
  try {
    code = normalizeBatchCode(decodeURIComponent(raw));
  } catch {
    return NextResponse.json({ error: "Ungültige Chargennummer" }, { status: 400 });
  }
  if (!BATCH_CODE_RE.test(code)) return NextResponse.json({ error: "Ungültige Chargennummer" }, { status: 400 });
  const status = await batchStatus(auth.organization.id, code);
  return NextResponse.json(status, { headers: { "Cache-Control": "private, no-store" } });
}
