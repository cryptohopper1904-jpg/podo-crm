/**
 * Pflicht-Bestätigung für externe KI-Anbieter (KI-Sprachmodell „llm“, Spracherkennung „transcription“), zugesagt in
 * docs/legal/UNTERAUFTRAGNEHMER.md: Wer einen solchen Anbieter einschaltet („verbunden (echt)“), muss als Inhaber:in
 * AVV mit § 203-Verpflichtung, EU/EWR-Verarbeitung, Zero Data Retention/kein Training und die Patienteninformation
 * bestätigen. Gespeichert werden Zeitpunkt, Benutzer, Textversion und das bestätigte Ziel (baseUrl + model) in der
 * Verbindungs-Config (integration_connections.config.dataProcessingApproval). Gültig ist die Bestätigung nur zur
 * aktuellen Textversion UND zum aktuellen Ziel – ein anderes Ziel verlangt eine neue Bestätigung. Ohne gültige
 * Bestätigung bleibt der Adapter gesperrt (registry → dataProcessingApproved). Rein und testbar.
 */

/** Version des Bestätigungstexts – bei inhaltlicher Änderung erhöhen (dann verfallen alle früheren Bestätigungen) */
export const AI_APPROVAL_VERSION = "ki-avv-203-eu-zdr-info-v2";

export const AI_APPROVAL_TEXT =
  "Ich bestätige als Verantwortliche/r für unsere Praxis: (1) Mit dem Anbieter besteht ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO, der ihn und seine Unterauftragsverarbeiter zur Verschwiegenheit nach § 203 Abs. 4 StGB verpflichtet. (2) Die Daten werden in der EU bzw. im EWR verarbeitet; eine Übermittlung in Drittländer oder ein Zugriff von dort (auch durch Unterauftragsverarbeiter oder Support) findet nicht statt oder ist durch Garantien nach Art. 44 ff. DSGVO abgesichert. (3) Der Anbieter speichert Eingaben und Ergebnisse nicht über die Verarbeitung hinaus (Zero Data Retention) und nutzt sie nicht zum Training. (4) Unsere Datenschutzhinweise für Patientinnen und Patienten informieren über diesen Einsatz.";

export const AI_APPROVAL_MISSING =
  "Externer KI-Anbieter nicht gespeichert: Für „verbunden (echt)“ bitte die Datenschutz-Bestätigung (AVV mit § 203-Verpflichtung, EU/EWR, Zero Data Retention und kein Training, Patienteninformation) ankreuzen.";

export const AI_APPROVAL_OWNER_ONLY = "Die Datenschutz-Bestätigung für einen externen KI-Anbieter kann nur die Inhaberin bzw. der Inhaber der Praxis abgeben.";
export const AI_APPROVAL_NO_SUPPORT = "Im Support-Zugang kann keine Datenschutz-Bestätigung für einen externen KI-Anbieter abgegeben werden – das kann nur die Praxis selbst.";

/** Hinweis für Inhaber:innen, wenn ein KI-Anbieter verbunden ist, die Bestätigung aber nicht (mehr) gilt */
export const AI_APPROVAL_PAUSED_HINT = "KI-Funktionen pausiert: Bitte unter Einstellungen → Schnittstellen die Datenschutz-Bestätigung erneuern.";

export type AiProvider = "llm" | "transcription";
export const isAiProvider = (p: string): p is AiProvider => p === "llm" || p === "transcription";

export type AiApproval = { at: string; by: string; version: string; baseUrl: string | null; model: string | null };

const target = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function approvalOf(cfg: Record<string, unknown> | null | undefined): AiApproval | null {
  const a = cfg?.dataProcessingApproval as Partial<AiApproval> | undefined;
  if (!a || typeof a !== "object" || typeof a.at !== "string" || typeof a.by !== "string" || typeof a.version !== "string") return null;
  if (Number.isNaN(Date.parse(a.at)) || !a.by) return null;
  return { at: a.at, by: a.by, version: a.version, baseUrl: target(a.baseUrl), model: target(a.model) };
}

/** Gültig nur mit Häkchen UND Bestätigung (Zeitpunkt, Benutzer) zur aktuellen Textversion UND zum aktuellen Ziel (baseUrl + model). */
export function aiApprovalValid(cfg: Record<string, unknown> | null | undefined): boolean {
  const a = approvalOf(cfg);
  return cfg?.dataProcessingApproved === true && !!a && a.version === AI_APPROVAL_VERSION && a.baseUrl === target(cfg?.baseUrl) && a.model === target(cfg?.model);
}

/** Bestätigung zur Anzeige (nur wenn gültig) */
export const aiApprovalInfo = (cfg: Record<string, unknown> | null | undefined): AiApproval | null => (aiApprovalValid(cfg) ? approvalOf(cfg) : null);

/** Warum gilt die Bestätigung nicht? (Anzeige) – null, wenn sie gilt oder nie abgegeben wurde */
export function aiApprovalProblem(cfg: Record<string, unknown> | null | undefined): "version" | "target" | null {
  if (aiApprovalValid(cfg)) return null;
  const a = approvalOf(cfg);
  if (!a) return cfg?.dataProcessingApproved === true ? "version" : null;
  if (a.version !== AI_APPROVAL_VERSION) return "version";
  return "target";
}

/**
 * Neue Config-Felder beim Speichern. Das Häkchen ist NIE vorbelegt: angekreuzt = neue Bestätigung (Zeitpunkt, Benutzer,
 * Ziel). Nicht angekreuzt: eine gültige Bestätigung zum UNVERÄNDERTEN Ziel bleibt bei „verbunden (echt)“ erhalten;
 * bei Zielwechsel (targetChanged) wird sie verworfen. „verbunden (echt)“ ohne danach gültige Bestätigung → Fehler.
 * Andere Status (aus, Testmodus) entfernen die Bestätigung. Neue Bestätigung nur durch die Inhaber:in, nie im Support-Zugang.
 */
export function nextAiApproval(
  oldConfig: Record<string, unknown> | null | undefined,
  newConfig: Record<string, unknown>,
  input: { status: string; checked: boolean; userId: string; role: string; support: boolean; targetChanged: boolean; now?: Date },
): { error: string } | { dataProcessingApproved: boolean; dataProcessingApproval: AiApproval | null; changed: boolean } {
  const hadValid = aiApprovalValid(oldConfig);
  if (input.checked) {
    if (input.support) return { error: AI_APPROVAL_NO_SUPPORT };
    if (input.role !== "owner") return { error: AI_APPROVAL_OWNER_ONLY };
    if (input.status !== "connected") return { dataProcessingApproved: false, dataProcessingApproval: null, changed: hadValid };
    return {
      dataProcessingApproved: true,
      dataProcessingApproval: { at: (input.now ?? new Date()).toISOString(), by: input.userId, version: AI_APPROVAL_VERSION, baseUrl: target(newConfig.baseUrl), model: target(newConfig.model) },
      changed: true,
    };
  }
  if (input.status !== "connected") return { dataProcessingApproved: false, dataProcessingApproval: null, changed: hadValid };
  const keep = hadValid && !input.targetChanged && aiApprovalValid({ ...newConfig, dataProcessingApproved: true, dataProcessingApproval: oldConfig?.dataProcessingApproval });
  if (!keep) return { error: AI_APPROVAL_MISSING };
  return { dataProcessingApproved: true, dataProcessingApproval: approvalOf(oldConfig), changed: false };
}

type ConnLike = { status: string; config?: Record<string, unknown> | null; secretEnc?: string | null } | null | undefined;

/**
 * Hat die Praxis ein eigenes Ziel eingetragen? Eigene Basis-URL ODER eigener API-Schlüssel (Verbindung nicht „aus“).
 * Dann gilt die env-Freigabe des Betreibers nicht – nötig ist die eigene Bestätigung der Inhaber:in.
 */
export const hasPracticeTarget = (conn: ConnLike) => !!conn && conn.status !== "disconnected" && (target(conn.config?.baseUrl) !== null || !!conn.secretEnc);

/**
 * Darf der KI-Anbieter Gesundheitsdaten verarbeiten? Gültige Bestätigung bei „verbunden (echt)“ ODER env-Freigabe des
 * Betreibers (LLM_/TRANSCRIPTION_DATA_PROCESSING_APPROVED) für den Plattform-Anbieter ohne Praxisziel. Rein, für
 * processingApproved (Server) und den Hinweis „KI pausiert“ auf „Heute“ – dieselbe Logik an beiden Stellen.
 */
export function aiProcessingApproved(conn: ConnLike, envApproved: boolean): boolean {
  if (conn?.status === "connected" && aiApprovalValid(conn.config)) return true;
  return envApproved && !hasPracticeTarget(conn);
}

/** env-Freigabe des Betreibers je Anbieter */
export const envAiApproved = (provider: AiProvider, env: Record<string, string | undefined> = process.env) =>
  (provider === "llm" ? env.LLM_DATA_PROCESSING_APPROVED : env.TRANSCRIPTION_DATA_PROCESSING_APPROVED) === "true";
