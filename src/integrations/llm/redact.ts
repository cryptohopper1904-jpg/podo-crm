/**
 * Pseudonymisierung vor dem Versand an ein LLM (Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO).
 *
 * Entfernt bzw. ersetzt durch Platzhalter: E-Mail-Adressen, Telefonnummern, Geburts-/Datumsangaben,
 * IBANs, Versichertennummern (KVNR) und – falls übergeben – bekannte Namen (z. B. der Patientin).
 * Freie Namen im Text erkennt diese einfache Regel-Logik NICHT zuverlässig. Sie ersetzt daher
 * weder AVV noch Zero-Data-Retention beim Anbieter – sie reduziert nur das Risiko.
 */

export interface RedactionResult {
  text: string;
  /** Platzhalter → Originalwert (bleibt im CRM, wird nie versendet) */
  map: Record<string, string>;
}

export interface RedactOptions {
  /** bekannte Namen (Vor-/Nachname, voller Name), werden wortgenau ersetzt */
  names?: (string | null | undefined)[];
  /** Datumsangaben behalten (z. B. Behandlungsdatum im Bericht) – Standard: false */
  keepDates?: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
/** KVNR: Buchstabe + 9 Ziffern */
const KVNR = /\b[A-Z]\d{9}\b/g;
/** Datumsangaben: 01.02.1950, 1.2.50, 1950-02-01, 1. Februar 1950 */
const DATE =
  /\b(?:\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s\d{4})\b/g;
/** Telefon: +49…, 0049…, 0…, mit Leerzeichen, /, -, () – mindestens 7 Ziffern */
const PHONE = /(?:\+|00)?\d[\d\s/().-]{5,}\d/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(input: string, opts: RedactOptions = {}): RedactionResult {
  const map: Record<string, string> = {};
  const counters: Record<string, number> = {};
  const seen = new Map<string, string>();
  const placeholder = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    const existing = seen.get(key);
    if (existing) return existing;
    counters[kind] = (counters[kind] ?? 0) + 1;
    const p = `[${kind}_${counters[kind]}]`;
    map[p] = value;
    seen.set(key, p);
    return p;
  };

  let text = input;
  text = text.replace(EMAIL, (m) => placeholder("EMAIL", m));
  text = text.replace(IBAN, (m) => placeholder("IBAN", m));
  text = text.replace(KVNR, (m) => placeholder("KVNR", m));
  if (!opts.keepDates) text = text.replace(DATE, (m) => placeholder("DATUM", m));
  text = text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    // Datumsangaben (bei keepDates) nicht als Telefonnummer werten
    if (/^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m;
    return digits.length >= 7 ? placeholder("TELEFON", m) : m;
  });

  const names = [...new Set((opts.names ?? []).filter((n): n is string => !!n && n.trim().length >= 2))]
    // längere zuerst, damit „Erika Beispiel“ vor „Erika“ ersetzt wird
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}])${escapeRegExp(name.trim())}(?![\\p{L}])`, "giu");
    text = text.replace(re, (m) => placeholder("NAME", m));
  }
  return { text, map };
}

/** Setzt die Originalwerte wieder ein (nur lokal, z. B. in einem Antwortentwurf). */
export function restore(text: string, map: Record<string, string>): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (p) => map[p] ?? p);
}
