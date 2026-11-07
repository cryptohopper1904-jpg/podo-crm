import { NextResponse, type NextRequest } from "next/server";
import { IntegrationNotConfiguredError } from "@/integrations/errors";
import { audit } from "@/lib/audit";
import { getAuth } from "@/lib/auth/session";
import { adapterFor } from "@/server/integrations";

/**
 * Sprachbericht → Transkript → strukturierte Doku-Felder (nur Entwurf, Therapeut:in prüft und speichert selbst).
 * Das Audio wird NICHT gespeichert – es existiert nur während dieser Anfrage im Arbeitsspeicher.
 */
const MAX_BYTES = 25 * 1024 * 1024;

const MOCK_TRANSCRIPT =
  "Befund: Nagel D1 rechts lateral eingewachsen, leichte Rötung, keine Entzündungszeichen. Hornhaut plantar unter MFK 2 und 3, Clavus an D5 links. " +
  "Behandlung: Nägel gekürzt und Nagelfalz gereinigt, Hornhaut abgetragen, Clavus enukleiert. Material: Nagelkorrekturspange gesetzt, Instrumente aus Charge 2026-114. " +
  "Reaktion: Behandlung gut vertragen, keine Blutung, beschwerdefrei. Empfehlung: Kontrolle der Spange in 4 Wochen, Druckentlastung mit Filzpolster, täglich Fußcreme mit Urea.";

const MOCK_FIELDS = {
  findings: "Nagel D1 rechts lateral eingewachsen, leichte Rötung, keine Entzündungszeichen. Hornhaut plantar unter MFK 2/3, Clavus D5 links.",
  servicesText: "Nägel gekürzt, Nagelfalz gereinigt, Hornhaut abgetragen, Clavus enukleiert, Nagelkorrekturspange D1 rechts gesetzt.",
  material: "Nagelkorrekturspange; Instrumente Charge 2026-114.",
  reaction: "Gut vertragen, keine Blutung, beschwerdefrei.",
  recommendation: "Spangenkontrolle in 4 Wochen; Druckentlastung mit Filzpolster; täglich Fußcreme mit Urea.",
};

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !auth.can("medical.write")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  const org = auth.organization.id;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Bitte als multipart/form-data mit Feld „audio“ senden." }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ error: "Audio fehlt." }, { status: 400 });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "Aufnahme zu groß (max. 25 MB)." }, { status: 413 });

  try {
    const transcriber = await adapterFor(org, "transcription");
    const llm = await adapterFor(org, "llm");
    let transcript: string;
    let fields: typeof MOCK_FIELDS;
    if (transcriber.isMock && llm.isMock) {
      transcript = MOCK_TRANSCRIPT;
      fields = MOCK_FIELDS;
    } else {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      transcript = transcriber.isMock
        ? MOCK_TRANSCRIPT
        : (await transcriber.transcribe(bytes, { mime: audio.type || "audio/webm", language: "de", filename: audio instanceof File ? audio.name : undefined })).text;
      const knownNames = String(form.get("knownNames") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await llm.structureReport(transcript, { knownNames });
      fields = { findings: r.findings, servicesText: r.services, material: r.material, reaction: r.reaction, recommendation: r.recommendation };
    }
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "ai.voice_report",
      entity: "patient",
      entityId: typeof form.get("patientId") === "string" ? String(form.get("patientId")) : undefined,
      meta: { bytes: audio.size, mock: transcriber.isMock && llm.isMock },
    });
    return NextResponse.json({ transcript, fields, aiAssisted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const status = e instanceof IntegrationNotConfiguredError ? 503 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "KI-Dienst nicht erreichbar." }, { status });
  }
}
