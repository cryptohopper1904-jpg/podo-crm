import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { createRateLimiter } from "@/lib/rate-limit";
import { buildPracticeExport } from "@/server/practice-export";

/** Höchstens ein Vollexport je Praxis in 10 Minuten (aufwendig: alle Tabellen + alle Fotos entschlüsseln). */
const limiter = createRateLimiter({ windowMs: 10 * 60_000, max: 1, maxKeys: 5_000 });

/** Vollständiger Datenexport der Praxis (nur Inhaber:in) als ZIP – Art. 20 DSGVO, Rückgabe nach Art. 28 Abs. 3 lit. g. */
export async function GET() {
  const auth = await getAuth();
  // Support-Zugriff (Break-Glass) ist ausdrücklich ausgeschlossen – auch mit Freigabe kein Vollexport.
  if (!auth || auth.support || auth.role !== "owner") return NextResponse.json({ error: "Nur Inhaber:innen können die Praxis exportieren." }, { status: 403 });
  if (!downloadAllowed(auth, "practice_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const org = auth.organization.id;
  if (limiter.limited(`org:${org}`)) {
    return NextResponse.json({ error: "Ein Export wurde gerade erstellt. Bitte in 10 Minuten erneut versuchen." }, { status: 429, headers: { "Retry-After": "600" } });
  }
  const result = await buildPracticeExport({ organizationId: org, exportedBy: { name: auth.user.name, email: auth.user.email } });
  // Der Export wird gestreamt: Beginn sofort protokollieren, Abschluss (mit Zahlen) bzw. Abbruch danach
  const base = { organizationId: org, userId: auth.user.id, entity: "organization", entityId: org } as const;
  await audit({ ...base, action: "org.export", meta: { status: "started" } });
  result.done.then(
    (r) =>
      audit({
        ...base,
        action: "org.export.completed",
        meta: { tables: Object.keys(r.counts).length, rows: Object.values(r.counts).reduce((a, b) => a + b, 0), mediaFiles: r.mediaFiles, mediaErrors: r.mediaErrors },
      }),
    (e: unknown) => audit({ ...base, action: "org.export.failed", meta: { error: e instanceof Error ? e.message.slice(0, 200) : "unbekannt" } }),
  ).catch(() => undefined);
  const slug = auth.organization.slug.replace(/[^a-z0-9-]/g, "");
  return new Response(result.stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="podocrm-export-${slug}-${berlinDateIso()}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
