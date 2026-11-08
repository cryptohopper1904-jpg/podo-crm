/**
 * Parser für Doctolib-Bestätigungs-/Absage-/Verschiebungsmails (Text-Teil).
 * Ergebnis ist nur ein Kandidat – Zuordnung zur Patientenakte und Konflikte werden manuell bestätigt.
 * Vor Produktivnutzung: Doctolib-Vertrag prüfen (automatisierte Auswertung erlaubt?), PLAN 14.4.
 */
import { berlinLocalToIso } from "../time";
import type { AppointmentCandidate } from "../types";

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11,
  dezember: 12, dez: 12,
};

function findLabeled(text: string, labels: string[]): string | null {
  for (const l of labels) {
    const m = text.match(new RegExp(`^\\s*${l}\\s*[:：]\\s*(.+)$`, "im"));
    if (m) return m[1].trim();
  }
  return null;
}

export function parseDoctolibEmail(body: string, subject = ""): AppointmentCandidate {
  const text = `${subject}\n${body}`.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const warnings: string[] = [];
  let confidence = 0;

  const lower = text.toLowerCase();
  let kind: AppointmentCandidate["kind"] = "unknown";
  if (/(abgesagt|storniert|annulliert|cancelled|canceled)/.test(lower)) kind = "cancelled";
  else if (/(verschoben|geändert|neuer zeitpunkt|umgebucht)/.test(lower)) kind = "moved";
  else if (/(bestätigt|gebucht|neuer termin|termin am|terminbestätigung|reserviert)/.test(lower)) kind = "booked";
  if (kind !== "unknown") confidence += 0.1;
  else warnings.push("Art der Mail (Buchung/Absage) nicht erkannt.");

  // Bei Verschiebungen steht der neue Termin meist hinter „neu“/„neuer Termin“ – diesen Abschnitt bevorzugen
  const scope = kind === "moved" ? (text.match(/neu(?:er)?\s+(?:termin|zeitpunkt)[\s\S]*/i)?.[0] ?? text) : text;

  let y: number | null = null, mo: number | null = null, d: number | null = null;
  let hh: number | null = null, mm: number | null = null;
  let m = scope.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[^\d\n]{0,25}?(\d{1,2})[:.](\d{2}))?/);
  if (m) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) [hh, mm] = [Number(m[4]), Number(m[5])];
  } else if ((m = scope.match(/(\d{1,2})\.?\s+([A-Za-zäÄöÖüÜ]+)\.?\s+(\d{4})(?:[^\d\n]{0,25}?(\d{1,2})[:.](\d{2}))?/))) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) {
      [d, mo, y] = [Number(m[1]), month, Number(m[3])];
      if (m[4]) [hh, mm] = [Number(m[4]), Number(m[5])];
    }
  } else if ((m = scope.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/))) {
    [y, mo, d, hh, mm] = m.slice(1, 6).map(Number);
  }
  if (hh === null) {
    const t = scope.match(/\b(?:um\s+)?(\d{1,2})[:.](\d{2})\s*uhr/i);
    if (t) [hh, mm] = [Number(t[1]), Number(t[2])];
  }

  let startsAt: string | null = null;
  if (y && mo && d) {
    confidence += 0.4;
    if (hh !== null && mm !== null && hh < 24 && mm < 60) {
      startsAt = berlinLocalToIso(y, mo, d, hh, mm);
      confidence += 0.2;
    } else warnings.push("Uhrzeit nicht gefunden.");
  } else warnings.push("Datum nicht gefunden.");

  const patientName = findLabeled(text, ["Patient(?:in)?", "Patient\\*in", "Name", "Für"]);
  if (patientName) confidence += 0.2;
  else warnings.push("Patientenname nicht gefunden.");
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
  const phone = findLabeled(text, ["Telefon", "Tel\\.?", "Mobil", "Telefonnummer"]);
  const reason = findLabeled(text, ["Besuchsgrund", "Grund", "Terminart", "Motiv", "Leistung", "Behandlung"]);
  const externalId = findLabeled(text, ["Termin-ID", "Buchungsnummer", "Referenz"]);

  return {
    kind,
    startsAt: kind === "unknown" && !startsAt ? null : startsAt,
    patientName,
    patientEmail: email && !/doctolib\./i.test(email) ? email.toLowerCase() : null,
    patientPhone: phone,
    reason,
    externalId,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    warnings,
  };
}
