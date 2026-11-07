import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import { redact, restore } from "@/integrations/llm/redact";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { getAuth } from "@/lib/auth/session";
import { adapterFor, logSync, processingApproved } from "@/server/integrations";
import { isUuid } from "@/server/webhooks";

/**
 * Sprachbericht → Transkript → strukturierte Doku-Felder (nur Entwurf, Therapeut:in prüft und speichert selbst).
 * - Das Audio wird NICHT gespeichert – es existiert nur während dieser Anfrage im Arbeitsspeicher.
 * - Echte Anbieter nur mit Freigabe (EU + AVV + Zero Data Retention).
 * - Namen der Person werden serverseitig geladen und vor dem LLM-Versand entfernt (redact/restore).
 * - Testmodus: Beispieltext, deutlich markiert, KEINE Feldvorschläge (keine erfundenen Befunde in der Akte).
 */
const MAX_BYTES = 25 * 1024 * 1024;
const LIMIT = 10;
const WINDOW_MS = 10 * 60_000;
const hits = new Map<string, number[]>();

/** Einfaches Rate-Limit je Benutzer (prozesslokal, Größe begrenzt). */
function limited(key: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  return false;
}

const MOCK_TRANSCRIPT =
  "[TESTMODUS – Beispieltext] Befund: Nagel D1 rechts lateral eingewachsen, leichte Rötung, keine Entzündungszeichen. Hornhaut plantar unter MFK 2 und 3, Clavus an D5 links. " +
  "Behandlung: Nägel gekürzt und Nagelfalz gereinigt, Hornhaut abgetragen, Clavus enukleiert. Material: Nagelkorrekturspange gesetzt, Instrumente aus Charge 2026-114. " +
  "Reaktion: Behandlung gut vertragen, keine Blutung, beschwerdefrei. Empfehlung: Kontrolle der Spange in 4 Wochen, Druckentlastung mit Filzpolster, täglich Fußcreme mit Urea.";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !auth.can("medical.write")) return fail(403, "Kein Zugriff");
  const org = auth.organization.id;
  if (limited(auth.user.id)) return fail(429, "Zu viele Anfragen – bitte in einigen Minuten erneut versuchen.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES + 1024 * 1024) return fail(413, "Aufnahme zu groß (max. 25 MB).");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "Bitte als multipart/form-data mit Feld „audio“ senden.");
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return fail(400, "Audio fehlt.");
  if (audio.size > MAX_BYTES) return fail(413, "Aufnahme zu groß (max. 25 MB).");

  // Person serverseitig laden (Mandant geprüft) – ihre Namen werden vor dem KI-Versand entfernt
  const rawPatientId = form.get("patientId");
  let patientId: string | undefined;
  const knownNames: string[] = [];
  if (typeof rawPatientId === "string" && rawPatientId) {
    if (!isUuid(rawPatientId)) return fail(400, "Ungültige Anfrage.");
    const [p] = await withOrg(org, (tx) =>
      tx
        .select({ firstName: patients.firstName, lastName: patients.lastName, extra: patients.extra })
        .from(patients)
        .where(and(eq(patients.organizationId, org), eq(patients.id, rawPatientId))),
    );
    if (!p) return fail(404, "Person nicht gefunden.");
    patientId = rawPatientId;
    const maiden = typeof (p.extra as Record<string, unknown>)?.maidenName === "string" ? ((p.extra as Record<string, unknown>).maidenName as string) : null;
    knownNames.push(...[[p.firstName, p.lastName].filter(Boolean).join(" "), p.firstName, p.lastName, maiden].filter((x): x is string => !!x));
  }

  try {
    const transcriber = await adapterFor(org, "transcription");
    const llm = await adapterFor(org, "llm");
    const mock = transcriber.isMock || llm.isMock;
    if (mock) {
      await audit({ organizationId: org, userId: auth.user.id, action: "ai.voice_report", entity: patientId ? "patient" : undefined, entityId: patientId, meta: { bytes: audio.size, mock: true } });
      return NextResponse.json({ transcript: MOCK_TRANSCRIPT, fields: {}, mock: true, aiAssisted: false }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!(await processingApproved(org, "transcription")) || !(await processingApproved(org, "llm"))) {
      return fail(503, "KI-Anbieter ist nicht für Gesundheitsdaten freigegeben (EU, AVV, Zero Data Retention in den Schnittstellen bestätigen).");
    }
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const { text: transcript } = await transcriber.transcribe(bytes, { mime: audio.type || "audio/webm", language: "de" });
    const { text: redacted, map } = redact(transcript, { names: knownNames });
    const r = await llm.structureReport(redacted, { knownNames });
    const fields = {
      findings: restore(r.findings, map),
      servicesText: restore(r.services, map),
      material: restore(r.material, map),
      reaction: restore(r.reaction, map),
      recommendation: restore(r.recommendation, map),
    };
    await audit({ organizationId: org, userId: auth.user.id, action: "ai.voice_report", entity: patientId ? "patient" : undefined, entityId: patientId, meta: { bytes: audio.size, mock: false } });
    return NextResponse.json({ transcript, fields, mock: false, aiAssisted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await logSync(org, "llm", { direction: "out", ok: false, message: `Sprachbericht: ${describeError(e)}` }).catch(() => undefined);
    return fail(502, "Der Sprachbericht konnte nicht verarbeitet werden. Bitte später erneut versuchen oder manuell dokumentieren.");
  }
}
