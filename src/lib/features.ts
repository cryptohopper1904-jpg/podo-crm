/**
 * Praxis-Modus „nur Privat-/Selbstzahler“ (organizations.settings.billingMode).
 *
 * Zentrale Feature-Map: Alle Bereiche, die bei „private_only“ ausgeblendet bzw. serverseitig gesperrt werden,
 * stehen HIER – statt verstreuter ifs fragen Seiten/Aktionen `feature(org, "<bereich>")`. Der Hinweistext in
 * Einstellungen → Praxisdaten wird aus derselben Liste erzeugt und passt so immer zu dem, was ausgeblendet ist.
 * Vorhandene Daten werden nie gelöscht – sie erscheinen wieder, sobald der Modus zurückgestellt wird.
 * Ohne DB-/Next-Abhängigkeiten (läuft auch im migrate-Container und in Tests).
 */

export const BILLING_MODES = ["with_gkv", "private_only"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
/** Bestandspraxen ohne Einstellung: mit Kassenzulassung */
export const DEFAULT_BILLING_MODE: BillingMode = "with_gkv";

export const isBillingMode = (v: unknown): v is BillingMode => v === "with_gkv" || v === "private_only";

/** billingMode aus organizations.settings (fehlend/ungültig → with_gkv) */
export function billingModeOf(settings: unknown): BillingMode {
  const v = settings && typeof settings === "object" ? (settings as Record<string, unknown>).billingMode : undefined;
  return isBillingMode(v) ? v : DEFAULT_BILLING_MODE;
}

/** Praxis-Objekt: entweder schon aufgelöst (AuthContext.organization.billingMode) oder mit rohen settings. */
export type OrgLike = { billingMode?: BillingMode | null; settings?: unknown } | null | undefined;

/** true, wenn die Praxis nur Privatpatient:innen & Selbstzahler behandelt (keine Kassenzulassung). */
export function isPrivateOnly(org: OrgLike): boolean {
  if (!org) return false;
  if (org.billingMode) return org.billingMode === "private_only";
  return billingModeOf(org.settings) === "private_only";
}

/**
 * Kassenbezogene Bereiche. `label` erscheint im Hinweis unter der Einstellung, `hint` (optional) ist das
 * Subjekt für den Hinweis bei direktem Aufruf („Verordnungen sind ausgeblendet …“).
 */
export const GKV_AREAS = {
  verordnungen: { label: "Verordnungen", hint: "Verordnungen sind" },
  gkvBilling: { label: "GKV-Abrechnung/Abrechnungszentrum", hint: "Die GKV-Abrechnung ist" },
  copayment: { label: "Zuzahlung" },
  ocr: { label: "Verordnungs-OCR", hint: "Die Verordnungs-OCR ist" },
  everordnung: { label: "eVerordnung", hint: "Der eVerordnungs-Import ist" },
  ti: { label: "TI & KIM", hint: "TI & KIM sind" },
  gkvServices: { label: "GKV-Positionen im Leistungskatalog" },
  gkvStats: { label: "Kassen-Auswertungen" },
  gkvNews: { label: "GKV-/Heilmittel-News" },
  kassenHints: { label: "Kassen-Hinweise auf Website und Rechnungen" },
} as const satisfies Record<string, { label: string; hint?: string }>;

export type GkvArea = keyof typeof GKV_AREAS;
/** "gkv" = Sammelschalter für alle Kassen-Themen */
export type FeatureKey = "gkv" | GkvArea;

export const isGkvArea = (v: unknown): v is GkvArea => typeof v === "string" && Object.hasOwn(GKV_AREAS, v);

/** Ist der Bereich für diese Praxis sichtbar/aktiv? */
export function feature(org: OrgLike, key: FeatureKey): boolean {
  // alle Kassen-Bereiche hängen derzeit am selben Schalter; die Feinaufteilung bleibt für spätere Modi offen
  void key;
  return !isPrivateOnly(org);
}

/** Liste der ausgeblendeten Bereiche, z. B. „Verordnungen, GKV-Abrechnung/…, … und Kassen-Hinweise …“ */
export function hiddenAreasText(): string {
  const labels = Object.values(GKV_AREAS).map((a) => a.label);
  return `${labels.slice(0, -1).join(", ")} und ${labels.at(-1)}`;
}

/** Erklärung direkt unter dem Schalter in Einstellungen → Praxisdaten. */
export function privateOnlyNote(): string {
  return `Blendet alle Kassen-Themen aus: ${hiddenAreasText()}. Vorhandene Daten bleiben erhalten und erscheinen wieder, wenn du den Haken entfernst.`;
}

export const PRIVATE_ONLY_LABEL = "Nur Privatpatient:innen & Selbstzahler (keine Kassenzulassung)";
const WHY = "weil deine Praxis nur Privatpatient:innen & Selbstzahler behandelt – ändern unter Einstellungen → Praxisdaten.";

/** Hinweis, wenn jemand einen ausgeblendeten Bereich direkt aufruft. */
export function hiddenAreaHint(area: GkvArea): string {
  const a: { label: string; hint?: string } = GKV_AREAS[area];
  return `${a.hint ?? `„${a.label}“ ist`} ausgeblendet, ${WHY}`;
}

/** Freundliche Fehlermeldung für serverseitig gesperrte Aktionen. */
export function gkvBlockedMessage(area: GkvArea = "verordnungen"): string {
  return `Nicht verfügbar: ${hiddenAreaHint(area)}`;
}

/** Ziel der Weiterleitung bei direktem Aufruf (Hinweis erscheint auf /heute). */
export const hiddenAreaRedirect = (area: GkvArea) => `/heute?ausgeblendet=${area}`;

/** Kategorie der News, in der GKV-/Heilmittel-Meldungen landen (src/lib/news-sources.ts) */
export const GKV_NEWS_CATEGORY = "Recht & Abrechnung";
/** GKV-/Heilmittel-Stichworte (bewusst ohne „Kasse“ allein – Registrierkassen-/TSE-Meldungen bleiben sichtbar) */
const GKV_NEWS_RE = /(^|[^\p{L}])(gkv\S*|krankenkasse\p{L}*|kassenärztlich\p{L}*|kassenzulassung|heilmittel\p{L}*|verordnung(en)?|e-?verordnung\p{L}*|zuzahlung\p{L}*|§\s*12[45]|sgb\s*v|abrechnungszentr\p{L}*|telematik\p{L}*|vdek|aok|g-ba)(?![\p{L}])/iu;

/** Meldung aus „Recht & Abrechnung“ mit GKV-/Heilmittel-Bezug? */
export function isGkvNews(item: { title?: string | null; summary?: string | null; category?: string | null }): boolean {
  if (item.category && item.category !== GKV_NEWS_CATEGORY) return false;
  return GKV_NEWS_RE.test(`${item.title ?? ""} ${item.summary ?? ""}`);
}

/** Filtert News-Einträge passend zum Praxis-Modus (minimaler Hook für die News-Seite). */
export function filterNewsForOrg<T extends { title?: string | null; summary?: string | null; category?: string | null }>(org: OrgLike, items: T[]): T[] {
  return feature(org, "gkvNews") ? items : items.filter((i) => !isGkvNews(i));
}

/** Serverseitige Sperre für Aktionen eines Kassen-Bereichs: `{ error }` bei „private_only“, sonst null. */
export function gkvGuard(org: OrgLike, area: GkvArea = "verordnungen"): { error: string } | null {
  return feature(org, area) ? null : { error: gkvBlockedMessage(area) };
}

/** Navigationspunkte, die bei „private_only“ verschwinden (Schlüssel aus src/components/app-nav.tsx) */
export const GKV_NAV_KEYS: readonly string[] = ["verordnungen"];

/** Entfernt ausgeblendete Navigationspunkte (in-place, damit der Aufruf im Layout eine Zeile bleibt). */
export function removeHiddenNav<T extends string>(org: OrgLike, keys: T[]): T[] {
  if (feature(org, "gkv")) return keys;
  for (let i = keys.length - 1; i >= 0; i--) if (GKV_NAV_KEYS.includes(keys[i])) keys.splice(i, 1);
  return keys;
}

/** Ansage für KI-Telefon/Buchung bei „private_only“ */
export const PRIVATE_ONLY_VOICE_NOTE = "Die Praxis behandelt nur Privatpatient:innen und Selbstzahler. Eine Abrechnung mit gesetzlichen Krankenkassen bzw. auf Kassenverordnung ist nicht möglich.";
