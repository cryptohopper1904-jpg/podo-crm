/**
 * Impressums-Pflichtangaben der Praxis (§ 5 DDG) – strukturiert in organizations.settings.imprint (Einstellungen →
 * Praxis), zusätzlich zu Name, Anschrift und Kontakt aus den Stammdaten. Gelten für die Praxis-Website (/p) und die
 * Online-Buchung (/buchen). Fehlen Pflichtangaben, ist die Online-Buchung gesperrt (src/server/portal-booking.ts) und
 * die App zeigt eine Warnung (Einstellungen, Heute).
 */

/** gesetzliche Berufsbezeichnungen nach § 1 PodG (auch „Medizinische Fußpflegerin/Medizinischer Fußpfleger“) */
export const PROFESSIONS = ["Podologin", "Podologe", "Medizinische Fußpflegerin", "Medizinischer Fußpfleger"] as const;
export const DEFAULT_PROFESSION_STATE = "Deutschland";
/** Standardtext nur für die gesetzlichen Berufsbezeichnungen nach PodG (PROFESSIONS) – nicht für eine Freitext-Berufsbezeichnung */
export const DEFAULT_REGULATIONS =
  "Podologengesetz (PodG) und Ausbildungs- und Prüfungsverordnung für Podologen (PodAPrV), abrufbar unter gesetze-im-internet.de";

/** Einzelpraxis: im Impressum „Inhaberin/Inhaber“ statt „Vertretungsberechtigte Person“ */
export const SOLE_PROPRIETOR = "Einzelpraxis";
/** Rechtsformen; registerpflichtige verlangen Registergericht und Registernummer (§ 5 Abs. 1 Nr. 4 DDG) */
export const LEGAL_FORMS = [
  { value: SOLE_PROPRIETOR, label: "Einzelpraxis (Einzelunternehmen)", register: false },
  { value: "GbR", label: "GbR (Praxisgemeinschaft)", register: false },
  { value: "eGbR", label: "eGbR (eingetragene GbR)", register: true },
  { value: "e. K.", label: "e. K. (eingetragene:r Kauffrau/Kaufmann)", register: true },
  { value: "PartG", label: "Partnerschaftsgesellschaft (PartG)", register: true },
  { value: "PartG mbB", label: "PartG mbB", register: true },
  { value: "OHG", label: "OHG", register: true },
  { value: "KG", label: "KG", register: true },
  { value: "GmbH & Co. KG", label: "GmbH & Co. KG", register: true },
  { value: "GmbH", label: "GmbH", register: true },
  { value: "UG (haftungsbeschränkt)", label: "UG (haftungsbeschränkt)", register: true },
] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number]["value"];

export const isKnownLegalForm = (v: string): v is LegalForm => LEGAL_FORMS.some((f) => f.value === v);
export const requiresRegister = (legalForm: string) => LEGAL_FORMS.some((f) => f.value === legalForm && f.register);
export const isKnownProfession = (v: string) => (PROFESSIONS as readonly string[]).includes(v);

export type ImprintSettings = {
  /** Inhaber:in bzw. vertretungsberechtigte Person */
  owner: string;
  /** gesetzliche Berufsbezeichnung (z. B. „Podologin“) */
  profession: string;
  /** Staat, in dem die Berufsbezeichnung verliehen wurde */
  professionState: string;
  /** berufsrechtliche Regelungen und wo sie zugänglich sind (bei Freitext-Berufsbezeichnung ohne Standardtext) */
  regulations: string;
  /** zuständige Aufsichtsbehörde (optional) */
  authority: string;
  /** Rechtsform (optional; LEGAL_FORMS), leer = keine Angabe */
  legalForm: string;
  /** Registergericht und Registernummer (Pflicht bei registerpflichtiger Rechtsform, sonst freiwillig) */
  registerCourt: string;
  registerNumber: string;
  /** Wirtschafts-Identifikationsnummer (§ 139c AO, optional) */
  economicId: string;
  /** Datenschutzbeauftragte:r: Name und Kontakt (optional; auch in den Datenschutzhinweisen) */
  dpo: string;
};

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function imprintSettings(settings: Record<string, unknown> | null | undefined): ImprintSettings {
  const i = (settings?.imprint ?? {}) as Record<string, unknown>;
  const profession = str(i.profession, 120);
  const storedRegulations = str(i.regulations, 500);
  const legalForm = str(i.legalForm, 60);
  return {
    owner: str(i.owner, 200),
    profession,
    professionState: str(i.professionState, 120) || DEFAULT_PROFESSION_STATE,
    // PodG-Standardtext nur bei den Berufsbezeichnungen nach PodG (Rechtsprüfung): bei Freitext nur, was die Praxis selbst einträgt
    regulations: isKnownProfession(profession)
      ? storedRegulations || DEFAULT_REGULATIONS
      : storedRegulations === DEFAULT_REGULATIONS ? "" : storedRegulations,
    authority: str(i.authority, 500),
    legalForm: isKnownLegalForm(legalForm) ? legalForm : "",
    registerCourt: str(i.registerCourt, 120),
    registerNumber: str(i.registerNumber, 60),
    economicId: str(i.economicId, 40),
    dpo: str(i.dpo, 500),
  };
}

/** Stammdaten, die zum Impressum gehören (organizations) */
export type ImprintBase = { name: string; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null };

export type ImprintField = "name" | "address" | "contact" | "owner" | "profession" | "register";

export const IMPRINT_FIELD_LABELS: Record<ImprintField, string> = {
  name: "Praxisname",
  address: "Anschrift (Straße, PLZ, Ort)",
  contact: "E-Mail-Adresse und Telefon",
  owner: "Inhaber:in bzw. vertretungsberechtigte Person",
  profession: "Berufsbezeichnung",
  register: "Registergericht und Registernummer",
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
  if (requiresRegister(i.legalForm) && (!has(i.registerCourt) || !has(i.registerNumber))) missing.push("register");
  return missing;
}

/** Platzhalter für die Aufsichtsbehörde (Einstellungen → Praxis → Impressum) */
export const AUTHORITY_PLACEHOLDER = "z. B. zuständiges Gesundheitsamt (nur wenn zutreffend)";

/** Impressum der Demo-Praxis (Seed/Bootstrap; erfundene Angaben) */
export const DEMO_IMPRINT: ImprintSettings = {
  owner: "Dana Demo",
  profession: "Podologin",
  professionState: DEFAULT_PROFESSION_STATE,
  regulations: DEFAULT_REGULATIONS,
  authority: "",
  legalForm: SOLE_PROPRIETOR,
  registerCourt: "",
  registerNumber: "",
  economicId: "",
  dpo: "",
};
