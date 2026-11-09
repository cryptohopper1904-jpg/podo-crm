/**
 * Zusatzmodul „Praxis-Website“: öffentliche Mikroseite /p/[slug] aus den Praxis-Einstellungen.
 * Reine Logik (ohne DB/Request) – genutzt von Seite, Einstellungen, Bootstrap und Tests.
 *
 * Gespeichert in organizations.settings:
 *   website        – { enabled, claim, about, showPrices, imprint, privacy, serviceDescriptions }
 *   websiteUrl     – bestehende eigene Website der Praxis (nur Verweis)
 *   openingHours   – [{ weekday: 1 (Mo) … 7 (So), from: "08:00", to: "17:00" }]
 *   homeVisitAreas – ["Hohen Neuendorf", …]
 *   openingDate    – "2026-11-01" (Eröffnung, optional)
 */
import { entitlements, type OrgBilling, type PlanId } from "./plans";

export type OpeningHour = { weekday: number; from: string; to: string };

export type WebsiteSettings = {
  enabled: boolean;
  claim: string;
  about: string;
  showPrices: boolean;
  /** Pflichtangaben fürs Impressum, die nicht aus den Stammdaten kommen (Berufsbezeichnung, Kammer/Aufsicht …) */
  imprint: string;
  /** Datenschutzerklärung der Praxis (Text) – die Praxis muss sie ausfüllen */
  privacy: string;
  /** Kurzbeschreibung je Leistungs-Code */
  serviceDescriptions: Record<string, string>;
};

export const WEEKDAYS: Record<number, string> = { 1: "Montag", 2: "Dienstag", 3: "Mittwoch", 4: "Donnerstag", 5: "Freitag", 6: "Samstag", 7: "Sonntag" };

export const LIMITS = { claim: 140, about: 2000, imprint: 3000, privacy: 20000, serviceDescription: 300, areas: 30, area: 60 } as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function websiteSettings(settings: Record<string, unknown> | null | undefined): WebsiteSettings {
  const w = (settings?.website ?? {}) as Partial<Record<keyof WebsiteSettings, unknown>>;
  const desc: Record<string, string> = {};
  if (w.serviceDescriptions && typeof w.serviceDescriptions === "object") {
    for (const [k, v] of Object.entries(w.serviceDescriptions as Record<string, unknown>)) {
      const d = str(v, LIMITS.serviceDescription);
      if (d && /^[\w-]{1,40}$/.test(k)) desc[k] = d;
    }
  }
  return {
    enabled: w.enabled === true,
    claim: str(w.claim, LIMITS.claim),
    about: str(w.about, LIMITS.about),
    showPrices: w.showPrices === true,
    imprint: str(w.imprint, LIMITS.imprint),
    privacy: str(w.privacy, LIMITS.privacy),
    serviceDescriptions: desc,
  };
}

/** Öffnungszeiten validiert und sortiert (ungültige Einträge werden verworfen). */
export function openingHours(settings: Record<string, unknown> | null | undefined): OpeningHour[] {
  const raw = settings?.openingHours;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => h as Partial<OpeningHour>)
    .filter((h): h is OpeningHour => Number.isInteger(h.weekday) && h.weekday! >= 1 && h.weekday! <= 7 && TIME.test(String(h.from)) && TIME.test(String(h.to)) && String(h.from) < String(h.to))
    .map((h) => ({ weekday: h.weekday, from: h.from, to: h.to }))
    .sort((a, b) => a.weekday - b.weekday || a.from.localeCompare(b.from));
}

export function homeVisitAreas(settings: Record<string, unknown> | null | undefined): string[] {
  const raw = settings?.homeVisitAreas;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((a) => str(a, LIMITS.area)).filter(Boolean))].slice(0, LIMITS.areas);
}

/** "Hohen Neuendorf, Stolpe; Birkenwerder\n…" → Liste */
export function parseAreas(input: string): string[] {
  return [...new Set(input.split(/[,;\n]/).map((a) => a.trim().slice(0, LIMITS.area)).filter(Boolean))].slice(0, LIMITS.areas);
}

/** Tarife, in denen die Website als Zusatzmodul buchbar ist (organizations.settings.websiteAddon). */
export const WEBSITE_ADDON_PLANS: readonly PlanId[] = ["starter"];
export const WEBSITE_ADDON_CENTS = 900;
export const websiteAddonActive = (settings: Record<string, unknown> | null | undefined) => settings?.websiteAddon === true;

export type WebsiteEntitlement = { entitled: boolean; source: "plan" | "addon" | null; addonAvailable: boolean; reason: string | null };

export function websiteEntitlement(org: OrgBilling, settings: Record<string, unknown> | null | undefined, now = new Date()): WebsiteEntitlement {
  const e = entitlements(org, now);
  const addonAvailable = WEBSITE_ADDON_PLANS.includes(e.plan);
  if (e.readOnly) return { entitled: false, source: null, addonAvailable, reason: "Die Praxis ist im Nur-Lesen-Modus – die Website ist offline." };
  if (e.features.has("website")) return { entitled: true, source: "plan", addonAvailable: false, reason: null };
  if (addonAvailable && websiteAddonActive(settings)) return { entitled: true, source: "addon", addonAvailable, reason: null };
  return {
    entitled: false,
    source: null,
    addonAvailable,
    reason: addonAvailable
      ? `Die Praxis-Website ist im Tarif „${e.planLabel}“ als Zusatzmodul buchbar (${WEBSITE_ADDON_CENTS / 100} €/Monat, vorläufig).`
      : `Die Praxis-Website ist im Tarif „${e.planLabel}“ nicht enthalten.`,
  };
}

/** Website öffentlich sichtbar? (eingeschaltet + Tarif/Zusatzmodul + nicht im Nur-Lesen-Modus) */
export function websitePublished(org: OrgBilling & { settings: Record<string, unknown> | null }, now = new Date()): boolean {
  return websiteSettings(org.settings).enabled && websiteEntitlement(org, org.settings, now).entitled;
}

/** Vorschläge für Kurzbeschreibungen bekannter Leistungen (die Praxis kann sie überschreiben). */
const DEFAULT_DESCRIPTIONS: [RegExp, string][] = [
  [/komplex/i, "Fachgerechte Behandlung von Nägeln und Haut – Hornhaut, Hühneraugen und Nagelprobleme, auch beim diabetischen Fuß."],
  [/spange|onyfix/i, "Sanfte Korrektur eingewachsener oder eingerollter Nägel – ohne Operation."],
  [/prothet/i, "Wiederaufbau verletzter oder fehlender Nagelteile mit Kunststoff – optisch und schützend."],
  [/orthos/i, "Individuell angefertigte Silikon-Orthosen zur Entlastung und Korrektur von Zehenfehlstellungen."],
  [/plasma/i, "Kaltplasma zur Unterstützung bei Nagelpilz und schlecht heilenden Wunden."],
  [/hausbesuch/i, "Wir kommen zu Ihnen nach Hause oder in die Pflegeeinrichtung."],
  [/hornhaut/i, "Schonende Abtragung von Hornhaut und Schwielen."],
  [/nagel/i, "Fachgerechtes Kürzen und Bearbeiten verdickter oder schwieriger Nägel."],
  [/kosmet/i, "Pflegende Fußbehandlung zum Wohlfühlen."],
];

export function defaultServiceDescription(name: string): string {
  return DEFAULT_DESCRIPTIONS.find(([re]) => re.test(name))?.[1] ?? "";
}

/** Kartenlink ohne Einbettung/Tracking (OpenStreetMap-Suche). */
export function mapLink(parts: (string | null | undefined)[]): string | null {
  const q = parts.filter(Boolean).join(", ");
  return q ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}` : null;
}

/** tel:-Link aus einer frei eingegebenen Telefonnummer */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.length < 5) return null;
  return `tel:${digits.startsWith("0") && !digits.startsWith("00") ? `+49${digits.slice(1)}` : digits}`;
}

/** Nur http(s)-Links aus Einstellungen übernehmen. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
