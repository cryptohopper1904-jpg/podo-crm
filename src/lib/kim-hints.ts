/**
 * Hinweise für die Zuordnung einer KIM-Nachricht (Arztbrief, Rückfrage) zu einer Person.
 * Es wird NIE automatisch zugeordnet – die Hinweise erzeugen nur Vorschläge, die Praxis entscheidet.
 * Reine Funktionen (testbar).
 */
import type { KimAttachmentInfo } from "@/integrations/types";

/** KVNR (unveränderbarer Teil der Krankenversichertennummer): 1 Großbuchstabe + 9 Ziffern, letzte = Prüfziffer. */
const KVNR_RE = /\b([A-Z][0-9]{9})\b/g;
const BIRTH_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
const NAME_TOKEN_RE = /\b[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?\b/g;

/** Häufige Wörter in Arztbriefen, die keine Nachnamen sind. */
const STOP = new Set(
  "Sehr Geehrte Geehrter Liebe Lieber Kolleginnen Kollegen Frau Herr Herrn Patient Patientin Praxis Arztbrief Befund Diagnose Diagnosen Therapie Therapiebericht Verordnung Rückfrage Antwort Grüßen Grüße Viele Freundlichen Mit Guten Tag Bitte Anbei Dank Vielen Datum Fußstatus Diabetes Polyneuropathie Behandlung Podologie Podologische Komplexbehandlung Hausarztpraxis Hausarzt Dr Med Testdaten Keine Letzten Ulzera Typ".split(
    " ",
  ),
);

/** Prüfziffer der KVNR (Buchstabe → zweistellige Zahl, Gewichte 1-2, Quersumme, mod 10). */
export function isValidKvnr(kvnr: string): boolean {
  if (!/^[A-Z]\d{9}$/.test(kvnr)) return false;
  const letter = String(kvnr.charCodeAt(0) - 64).padStart(2, "0");
  const digits = (letter + kvnr.slice(1, 9)).split("").map(Number);
  let sum = 0;
  digits.forEach((d, i) => {
    const p = d * (i % 2 === 0 ? 1 : 2);
    sum += p > 9 ? Math.floor(p / 10) + (p % 10) : p;
  });
  return sum % 10 === Number(kvnr[9]);
}

export interface KimHints {
  kvnrs: string[];
  /** YYYY-MM-DD */
  birthDates: string[];
  /** mögliche Nachnamen (klein geschrieben) */
  nameTokens: string[];
}

export function extractKimHints(subject: string | null | undefined, body: string | null | undefined): KimHints {
  const text = `${subject ?? ""}\n${(body ?? "").slice(0, 5000)}`;
  const kvnrs = [...new Set([...text.matchAll(KVNR_RE)].map((m) => m[1]))].slice(0, 5);
  const birthDates = [
    ...new Set(
      [...text.matchAll(BIRTH_RE)]
        .map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`)
        .filter((d) => !Number.isNaN(new Date(d).getTime()) && d >= "1900-01-01"),
    ),
  ].slice(0, 5);
  const nameTokens = [...new Set([...text.matchAll(NAME_TOKEN_RE)].map((m) => m[0]).filter((t) => t.length >= 3 && !STOP.has(t)).map((t) => t.toLowerCase()))].slice(0, 40);
  return { kvnrs, birthDates, nameTokens };
}

export interface PatientCandidate {
  id: string;
  number: number;
  firstName: string | null;
  lastName: string;
  birthDate: string | null;
  insuranceNumber: string | null;
}

export interface PatientSuggestion {
  patient: PatientCandidate;
  score: number;
  reasons: string[];
}

/** Bewertet Kandidaten; nur sinnvolle Vorschläge (mind. Nachname + weiteres Merkmal oder KVNR). */
export function rankSuggestions(hints: KimHints, candidates: PatientCandidate[], max = 3): PatientSuggestion[] {
  const out: PatientSuggestion[] = [];
  for (const p of candidates) {
    const reasons: string[] = [];
    let score = 0;
    const kvnr = p.insuranceNumber?.trim().toUpperCase().slice(0, 10);
    if (kvnr && hints.kvnrs.includes(kvnr)) {
      score += 10;
      reasons.push("KVNR");
    }
    const last = hints.nameTokens.includes(p.lastName.toLowerCase());
    const first = !!p.firstName && hints.nameTokens.includes(p.firstName.toLowerCase());
    if (last) {
      score += 3;
      reasons.push(first ? "Vor- und Nachname" : "Nachname");
      if (first) score += 2;
    }
    if (p.birthDate && hints.birthDates.includes(p.birthDate)) {
      score += 4;
      reasons.push("Geburtsdatum");
    }
    if (score >= 5 || reasons.includes("KVNR")) out.push({ patient: p, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Anhänge als lesbare Zeile im Nachrichtentext (Anhänge selbst werden nicht gespeichert). */
export function attachmentNote(list: KimAttachmentInfo[]): string {
  if (!list.length) return "";
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
  return `\n\n[KIM-Anhänge (nicht übernommen – bitte im KIM-Clientmodul öffnen): ${list.map((a) => `${a.filename} (${kb(a.size)})`).join(", ")}]`;
}
