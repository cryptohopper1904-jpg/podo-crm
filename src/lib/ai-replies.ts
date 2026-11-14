/**
 * KI-Antwortvorschläge im Posteingang – Schalter je Praxis (organizations.settings.aiReplies), Standard AUS.
 * Einschalten nur mit settings.manage, nach Bestätigung von AVV und Verschwiegenheit (§ 203 Abs. 4 StGB) und mit
 * Anbieter-Name und Land: beides erscheint in den Datenschutzhinweisen der Online-Buchung
 * (src/app/p/[slug]/_site/legal-content.tsx). Der KI-Dienst ist ein von der Praxis selbst beauftragter Dienst
 * (eigener Vertrag), kein Unterauftragnehmer von PodoHero (AVV § 6 Nr. 4, § 7).
 */

export type AiReplySettings = {
  enabled: boolean;
  provider: string;
  country: string;
  /** Nachweis der Bestätigungen beim Einschalten */
  avvConfirmed: boolean;
  confidentialityConfirmed: boolean;
  at: string | null;
  by: string | null;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

export const AI_PROVIDER_MAX = 120;
export const AI_COUNTRY_MAX = 60;

/** Liest den Schalter; „an“ nur, wenn alle Pflichtangaben gespeichert sind (fail closed). */
export function aiReplySettings(settings: Record<string, unknown> | null | undefined): AiReplySettings {
  const a = (settings?.aiReplies ?? {}) as Record<string, unknown>;
  const provider = str(a.provider, AI_PROVIDER_MAX);
  const country = str(a.country, AI_COUNTRY_MAX);
  const avvConfirmed = a.avvConfirmed === true;
  const confidentialityConfirmed = a.confidentialityConfirmed === true;
  return {
    enabled: a.enabled === true && avvConfirmed && confidentialityConfirmed && !!provider && !!country,
    provider,
    country,
    avvConfirmed,
    confidentialityConfirmed,
    at: typeof a.at === "string" ? a.at : null,
    by: typeof a.by === "string" ? a.by : null,
  };
}

/** Für die Datenschutzhinweise: Anbieter und Land bei eingeschaltetem Schalter, sonst null */
export function aiReplyDisclosure(settings: Record<string, unknown> | null | undefined): { provider: string; country: string } | null {
  const a = aiReplySettings(settings);
  return a.enabled ? { provider: a.provider, country: a.country } : null;
}

/** Kanäle, auf die eine Antwort möglich ist – nur für sie gibt es KI-Vorschläge (keine internen Hinweise/Telefonnotizen) */
export const AI_REPLY_CHANNELS = ["email", "sms", "whatsapp", "kim"] as const;
export const aiReplyChannel = (channel: string) => (AI_REPLY_CHANNELS as readonly string[]).includes(channel);
