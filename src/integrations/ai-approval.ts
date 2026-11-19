/**
 * Pflicht-Bestätigung für externe KI-Anbieter (KI-Antwortvorschläge „llm“, Spracherkennung „transcription“):
 * Wer einen solchen Anbieter einschaltet („verbunden (echt)“), muss AVV, EU-Verarbeitung und „kein Training“ bestätigen.
 * Ohne Häkchen lehnt der Server das Speichern ab. Gespeichert werden Zeitpunkt, Benutzer und Textversion in der
 * Verbindungs-Config (integration_connections.config.dataProcessingApproval). Ohne gültige Bestätigung bleibt der
 * Adapter gesperrt (registry → dataProcessingApproved). Rein und testbar.
 */

/** Version des Bestätigungstexts – bei inhaltlicher Änderung erhöhen (dann ist eine erneute Bestätigung nötig) */
export const AI_APPROVAL_VERSION = "ki-avv-eu-kein-training-v1";

export const AI_APPROVAL_TEXT =
  "Ich habe mit dem Anbieter einen AVV geschlossen, die Verarbeitung erfolgt in der EU und der Anbieter nutzt die Daten nicht zum Training.";

export const AI_APPROVAL_MISSING =
  "Externer KI-Anbieter nicht gespeichert: Bitte bestätigen, dass mit dem Anbieter ein AVV geschlossen ist, die Verarbeitung in der EU erfolgt und der Anbieter die Daten nicht zum Training nutzt.";

export type AiProvider = "llm" | "transcription";
export const isAiProvider = (p: string): p is AiProvider => p === "llm" || p === "transcription";

export type AiApproval = { at: string; by: string; version: string };

function approvalOf(cfg: Record<string, unknown> | null | undefined): AiApproval | null {
  const a = cfg?.dataProcessingApproval as Partial<AiApproval> | undefined;
  if (!a || typeof a !== "object" || typeof a.at !== "string" || typeof a.by !== "string" || typeof a.version !== "string") return null;
  if (Number.isNaN(Date.parse(a.at)) || !a.by) return null;
  return { at: a.at, by: a.by, version: a.version };
}

/** Gültig nur mit Häkchen UND gespeicherter Bestätigung (Zeitpunkt, Benutzer) zur aktuellen Textversion. */
export function aiApprovalValid(cfg: Record<string, unknown> | null | undefined): boolean {
  const a = approvalOf(cfg);
  return cfg?.dataProcessingApproved === true && !!a && a.version === AI_APPROVAL_VERSION;
}

/** Bestätigung zur Anzeige (nur wenn gültig) */
export const aiApprovalInfo = (cfg: Record<string, unknown> | null | undefined): AiApproval | null => (aiApprovalValid(cfg) ? approvalOf(cfg) : null);

/**
 * Neue Config-Felder beim Speichern: „verbunden (echt)“ ohne Häkchen → Fehler. Mit Häkchen bleibt eine gültige
 * Bestätigung (Zeitpunkt/Benutzer der ersten Bestätigung) erhalten, sonst wird sie neu gesetzt. Ohne Häkchen wird sie entfernt.
 */
export function nextAiApproval(
  oldConfig: Record<string, unknown> | null | undefined,
  input: { status: string; checked: boolean; userId: string; now?: Date },
): { error: string } | { dataProcessingApproved: boolean; dataProcessingApproval: AiApproval | null; changed: boolean } {
  if (input.status === "connected" && !input.checked) return { error: AI_APPROVAL_MISSING };
  if (!input.checked) return { dataProcessingApproved: false, dataProcessingApproval: null, changed: aiApprovalValid(oldConfig) };
  if (aiApprovalValid(oldConfig)) return { dataProcessingApproved: true, dataProcessingApproval: approvalOf(oldConfig), changed: false };
  return { dataProcessingApproved: true, dataProcessingApproval: { at: (input.now ?? new Date()).toISOString(), by: input.userId, version: AI_APPROVAL_VERSION }, changed: true };
}
