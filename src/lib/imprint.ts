/**
 * Impressums-Pflichtangaben der Praxis (§ 5 DDG) – strukturiert in organizations.settings.imprint (Einstellungen →
 * Praxis), zusätzlich zu Name, Anschrift und Kontakt aus den Stammdaten. Gelten für die Praxis-Website (/p) und die
 * Online-Buchung (/buchen). Fehlen Pflichtangaben, ist die Online-Buchung gesperrt (src/server/portal-booking.ts) und
 * die Einstellungen zeigen eine Warnung.
 */

export const PROFESSIONS = ["Podologin", "Podologe"] as const;
export const DEFAULT_PROFESSION_STATE = "Deutschland";
export const DEFAULT_REGULATIONS =
  "Podologengesetz (PodG) und Ausbildungs- und Prüfungsverordnung für Podologen (PodAPrV), abrufbar unter gesetze-im-internet.de";

export type ImprintSettings = {
  /** Inhaber:in bzw. vertretungsberechtigte Person */
  owner: string;
  /** gesetzliche Berufsbezeichnung (z. B. „Podologin“) */
  profession: string;
  /** Staat, in dem die Berufsbezeichnung verliehen wurde */
  professionState: string;
  /** berufsrechtliche Regelungen und wo sie zugänglich sind */
  regulations: string;
  /** zuständige Aufsichtsbehörde (optional) */
  authority: string;
};

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function imprintSettings(settings: Record<string, unknown> | null | undefined): ImprintSettings {
  const i = (settings?.imprint ?? {}) as Record<string, unknown>;
  return {
    owner: str(i.owner, 200),
    profession: str(i.profession, 120),
    professionState: str(i.professionState, 120) || DEFAULT_PROFESSION_STATE,
    regulations: str(i.regulations, 500) || DEFAULT_REGULATIONS,
    authority: str(i.authority, 500),
  };
}

/** Stammdaten, die zum Impressum gehören (organizations) */
export type ImprintBase = { name: string; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null };

export type ImprintField = "name" | "address" | "contact" | "owner" | "profession";

export const IMPRINT_FIELD_LABELS: Record<ImprintField, string> = {
  name: "Praxisname",
  address: "Anschrift (Straße, PLZ, Ort)",
  contact: "E-Mail-Adresse und Telefon",
  owner: "Inhaber:in bzw. vertretungsberechtigte Person",
  profession: "Berufsbezeichnung",
};

/** Fehlende Pflichtangaben (leer = Impressum vollständig) */
export function missingImprintFields(o: ImprintBase, settings: Record<string, unknown> | null | undefined): ImprintField[] {
  const i = imprintSettings(settings);
  const has = (v: string | null | undefined) => !!v && v.trim().length > 0;
  const missing: ImprintField[] = [];
  if (!has(o.name)) missing.push("name");
  if (!has(o.street) || !has(o.zip) || !has(o.city)) missing.push("address");
  if (!has(o.email) || !has(o.phone)) missing.push("contact");
  if (!has(i.owner)) missing.push("owner");
  if (!has(i.profession)) missing.push("profession");
  return missing;
}

/** Impressum der Demo-Praxis (Seed/Bootstrap; erfundene Angaben) */
export const DEMO_IMPRINT: ImprintSettings = {
  owner: "Dana Demo",
  profession: "Podologin",
  professionState: DEFAULT_PROFESSION_STATE,
  regulations: DEFAULT_REGULATIONS,
  authority: "",
};
