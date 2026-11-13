/**
 * „Patient:in verstorben“ – reine Hilfsfunktionen (ohne DB/Server-Importe, testbar).
 *
 * Gespeichert in patients.extra.deceased (jsonb, keine Migration nötig):
 *   { date: "YYYY-MM-DD" | null, markedAt: ISO-Zeitpunkt, markedBy: user-id | null }
 *
 * Wirkung (siehe src/server/patient-deceased.ts und die jeweiligen Stellen):
 *  - keine Erinnerungen/Rückholung/Spangen-Kontrolle, keine Wartelisten-Angebote,
 *    kein Portal-Zugang und keine neuen Patienten-Links, keine Online-Buchung über das Portal,
 *    keine neuen künftigen Termine.
 *  - Die Akte bleibt lesbar und wird nicht gelöscht (Aufbewahrungspflicht 10 Jahre, § 630f BGB).
 *  - Rechnungen für erfolgte Behandlungen bleiben möglich (an Erb:innen bzw. Rechnungsempfänger:in).
 */

export const DECEASED_KEY = "deceased";

export type DeceasedInfo = { date: string | null; markedAt: string; markedBy: string | null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Liest die Markierung aus patients.extra; null = nicht als verstorben markiert. */
export function deceasedInfo(extra: unknown): DeceasedInfo | null {
  if (!extra || typeof extra !== "object") return null;
  const raw = (extra as Record<string, unknown>)[DECEASED_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    date: typeof r.date === "string" && ISO_DATE.test(r.date) ? r.date : null,
    markedAt: typeof r.markedAt === "string" ? r.markedAt : "",
    markedBy: typeof r.markedBy === "string" ? r.markedBy : null,
  };
}

export function isDeceased(extra: unknown): boolean {
  return deceasedInfo(extra) !== null;
}

/**
 * Sterbedatum aus dem Formular prüfen: leer → null (optional), sonst TT.MM.JJJJ oder JJJJ-MM-TT,
 * gültiges Kalenderdatum, nicht in der Zukunft und nicht vor dem Geburtsdatum.
 */
export function parseDeathDate(
  raw: string | null | undefined,
  opts: { today: string; birthDate?: string | null },
): { ok: true; date: string | null } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, date: null };
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = de ? `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}` : s;
  if (!ISO_DATE.test(iso)) return { ok: false, error: "Sterbedatum bitte als TT.MM.JJJJ eingeben." };
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return { ok: false, error: "Sterbedatum ist kein gültiges Datum." };
  if (iso > opts.today) return { ok: false, error: "Das Sterbedatum darf nicht in der Zukunft liegen." };
  if (opts.birthDate && iso < opts.birthDate) return { ok: false, error: "Das Sterbedatum liegt vor dem Geburtsdatum." };
  return { ok: true, date: iso };
}

export const DECEASED_LABEL = "verstorben";
export const DECEASED_BLOCKED_MSG = "Die Patient:in ist als verstorben markiert – keine neuen Termine möglich.";
