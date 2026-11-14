/**
 * KI-Antwortvorschläge (Posteingang und Google-Bewertungen) – Schalter je Praxis (organizations.settings.aiReplies),
 * Standard AUS. Einschalten nur durch die Inhaber:in, nach Bestätigung von AVV und Verschwiegenheit
 * (§ 203 Abs. 3 und 4 StGB), mit Anbieter-Name und Land aus der Liste (AI_COUNTRIES); außerhalb von EU/EWR zusätzlich
 * mit Bestätigung der Garantien für die Übermittlung (Art. 44 ff. DSGVO). Anbieter und Land erscheinen in den
 * Datenschutzhinweisen der Online-Buchung (src/app/p/[slug]/_site/legal-content.tsx). Ausschalten darf jede Person mit
 * settings.manage. Der KI-Dienst ist ein von der Praxis selbst beauftragter Dienst (eigener Vertrag), kein
 * Unterauftragnehmer von PodoHero (AVV § 6 Nr. 4, § 7 Nr. 2).
 */

export type AiReplySettings = {
  enabled: boolean;
  provider: string;
  country: string;
  /** Land außerhalb von EU/EWR (Drittland) */
  thirdCountry: boolean;
  /** Nachweis der Bestätigungen beim Einschalten */
  avvConfirmed: boolean;
  confidentialityConfirmed: boolean;
  /** nur bei Drittland: Angemessenheitsbeschluss oder Standardvertragsklauseln bestätigt */
  transferConfirmed: boolean;
  at: string | null;
  by: string | null;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

export const AI_PROVIDER_MAX = 120;
export const AI_COUNTRY_MAX = 60;

/**
 * Länder für „Land der Verarbeitung“ (Auswahlliste statt Freitext, Recht M-88-6): EU/EWR und häufige Drittländer.
 * `in` = Ortsangabe für die Datenschutzhinweise („in der Schweiz“, „in den USA“).
 */
export const AI_COUNTRIES: readonly { name: string; in: string; euEea: boolean }[] = [
  ...(
    [
      ["Belgien"], ["Bulgarien"], ["Dänemark"], ["Deutschland"], ["Estland"], ["Finnland"], ["Frankreich"], ["Griechenland"], ["Irland"],
      ["Island"], ["Italien"], ["Kroatien"], ["Lettland"], ["Liechtenstein"], ["Litauen"], ["Luxemburg"], ["Malta"], ["Niederlande", "in den Niederlanden"],
      ["Norwegen"], ["Österreich"], ["Polen"], ["Portugal"], ["Rumänien"], ["Schweden"], ["Slowakei", "in der Slowakei"], ["Slowenien"], ["Spanien"],
      ["Tschechien"], ["Ungarn"], ["Zypern"],
    ] as [string, string?][]
  ).map(([name, inPhrase]) => ({ name, in: inPhrase ?? `in ${name}`, euEea: true })),
  { name: "Schweiz", in: "in der Schweiz", euEea: false },
  { name: "Vereinigtes Königreich", in: "im Vereinigten Königreich", euEea: false },
  { name: "USA", in: "in den USA", euEea: false },
  { name: "Kanada", in: "in Kanada", euEea: false },
  { name: "Japan", in: "in Japan", euEea: false },
];

export const aiCountry = (name: string) => AI_COUNTRIES.find((c) => c.name === name) ?? null;

/** Liest den Schalter; „an“ nur, wenn alle Pflichtangaben gespeichert sind (fail closed). */
export function aiReplySettings(settings: Record<string, unknown> | null | undefined): AiReplySettings {
  const a = (settings?.aiReplies ?? {}) as Record<string, unknown>;
  const provider = str(a.provider, AI_PROVIDER_MAX);
  const country = str(a.country, AI_COUNTRY_MAX);
  const known = aiCountry(country);
  const avvConfirmed = a.avvConfirmed === true;
  const confidentialityConfirmed = a.confidentialityConfirmed === true;
  const transferConfirmed = a.transferConfirmed === true;
  const thirdCountry = known ? !known.euEea : false;
  return {
    // unbekanntes Land (z. B. alter Freitext) oder Drittland ohne Garantie-Bestätigung → aus
    enabled: a.enabled === true && avvConfirmed && confidentialityConfirmed && !!provider && !!known && (known.euEea || transferConfirmed),
    provider,
    country: known ? known.name : country,
    thirdCountry,
    avvConfirmed,
    confidentialityConfirmed,
    transferConfirmed,
    at: typeof a.at === "string" ? a.at : null,
    by: typeof a.by === "string" ? a.by : null,
  };
}

export type AiReplyDisclosure = { provider: string; country: string; countryIn: string; thirdCountry: boolean };

/** Für die Datenschutzhinweise: Anbieter und Land bei eingeschaltetem Schalter, sonst null */
export function aiReplyDisclosure(settings: Record<string, unknown> | null | undefined): AiReplyDisclosure | null {
  const a = aiReplySettings(settings);
  const c = aiCountry(a.country);
  return a.enabled && c ? { provider: a.provider, country: c.name, countryIn: c.in, thirdCountry: !c.euEea } : null;
}

/**
 * Kanäle, auf die eine Antwort möglich ist – nur für sie gibt es KI-Vorschläge (keine internen Hinweise/Telefonnotizen).
 * KIM bewusst nicht (Recht/AppSec L-2): Arztbriefe enthalten Gesundheitsdaten Dritter, die nicht an einen KI-Dienst gehen.
 */
export const AI_REPLY_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const aiReplyChannel = (channel: string) => (AI_REPLY_CHANNELS as readonly string[]).includes(channel);
