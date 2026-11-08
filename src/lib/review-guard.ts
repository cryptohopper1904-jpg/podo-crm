/**
 * Schweigepflicht-Prüfung für öffentliche Antworten auf Bewertungen (§ 203 StGB, Art. 9 DSGVO).
 * Eine öffentliche Antwort darf weder bestätigen, dass jemand Patient:in ist, noch Behandlungs-
 * oder Gesundheitsangaben enthalten. Die Liste ist bewusst streng – lieber neutral formulieren.
 */
import { wordRegex } from "./unicode-regex";
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: wordRegex(String.raw`\b(behandl\w*|therap\w*|termin\w*|sitzung\w*|besuch(e|en|s)? (bei|in) (uns|unserer praxis))\b`), label: "Behandlung/Termin" },
  { re: wordRegex(String.raw`\b(diagnos\w*|befund\w*|erkrank\w*|krankheit\w*|beschwerden|schmerz\w*|entzünd\w*|infekt\w*|wunde\w*|heilung\w*)\b`), label: "Gesundheitsangabe" },
  { re: wordRegex(String.raw`\b(nagel\w*|nägel\w*|nagelpilz|mykose|hühnerauge\w*|clavus|hornhaut|warze\w*|spange\w*|eingewachsen\w*|fußpilz|diabet\w*|rheuma\w*|neuropath\w*)\b`), label: "Befund/Leistung" },
  { re: wordRegex(String.raw`\b(rezept\w*|verordnung\w*|krankenkasse\w*|kasse|heilmittel\w*|arzt|ärzt\w*)\b`), label: "Verordnung/Kasse" },
  { re: wordRegex(String.raw`\b(ihr(e[mnrs]?)? (fuß|füße|fuss|zeh\w*|bein\w*))\b`), label: "Körperbezug" },
  { re: wordRegex(String.raw`\b(als (unser(e)?|langjährig\w*) (patient\w*|kund\w*)|unser(e)? (patient\w*))\b`), label: "Bestätigung Patientenstatus" },
];

/** Gibt die gefundenen Problem-Kategorien zurück (leer = ok). */
export function reviewReplyProblems(text: string): string[] {
  return [...new Set(FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.label))];
}

/** Neutrale Vorlage, falls ein KI-Vorschlag verworfen wird. */
export function neutralReviewReply(rating: number | null, practiceName: string): string {
  if (rating !== null && rating <= 3) {
    return `Vielen Dank für Ihre Rückmeldung. Es tut uns leid, dass Sie nicht rundum zufrieden waren. Bitte sprechen Sie uns gern direkt an, damit wir Ihr Anliegen persönlich klären können.\n\nIhr Team von ${practiceName}`;
  }
  return `Herzlichen Dank für Ihre freundliche Bewertung – wir freuen uns sehr über Ihr Feedback!\n\nIhr Team von ${practiceName}`;
}
