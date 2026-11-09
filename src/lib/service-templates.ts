/**
 * Vorlagen für den Leistungskatalog (Onboarding). Preise sind Beispielwerte – die Praxis passt sie an.
 * GKV-Positionen: Positionsnummern und Vergütung stehen im Vertrag nach § 125 SGB V / in der Preisliste der
 * Kassen. Sie werden deshalb INAKTIV ohne Preis angelegt und müssen vor Nutzung geprüft/aktiviert werden.
 */
import { DEFAULT_SERVICES } from "./org-defaults";

export type ServiceTemplateId = "standard" | "selfpay" | "gkv";

export type TemplateService = {
  code: string;
  name: string;
  priceCents: number;
  vatRate: number;
  durationMin: number;
  category: string;
  requiresTherapeuticPurpose: boolean;
  active: boolean;
};

const fromDefaults = (): TemplateService[] =>
  DEFAULT_SERVICES.map((s) => ({
    code: s.code,
    name: s.name,
    priceCents: s.priceCents,
    vatRate: s.vatRate,
    durationMin: s.durationMin,
    category: s.category,
    requiresTherapeuticPurpose: "requiresTherapeuticPurpose" in s ? s.requiresTherapeuticPurpose : true,
    active: true,
  }));

const SELFPAY_EXTRA: TemplateService[] = [
  { code: "FB", name: "Fußbad und Fußmassage (Wellness)", priceCents: 2500, vatRate: 19, durationMin: 20, category: "cosmetic", requiresTherapeuticPurpose: false, active: true },
  { code: "LA", name: "Nägel lackieren", priceCents: 1000, vatRate: 19, durationMin: 10, category: "cosmetic", requiresTherapeuticPurpose: false, active: true },
];

const GKV_EXTRA: TemplateService[] = [
  { code: "GPK", name: "GKV: Podologische Komplexbehandlung (Preis/Position prüfen)", priceCents: 0, vatRate: 0, durationMin: 40, category: "treatment", requiresTherapeuticPurpose: true, active: false },
  { code: "GHH", name: "GKV: Hornhautabtragung (Preis/Position prüfen)", priceCents: 0, vatRate: 0, durationMin: 25, category: "treatment", requiresTherapeuticPurpose: true, active: false },
  { code: "GNB", name: "GKV: Nagelbearbeitung (Preis/Position prüfen)", priceCents: 0, vatRate: 0, durationMin: 25, category: "treatment", requiresTherapeuticPurpose: true, active: false },
  { code: "GNS", name: "GKV: Nagelkorrekturspange (Preis/Position prüfen)", priceCents: 0, vatRate: 0, durationMin: 30, category: "brace", requiresTherapeuticPurpose: true, active: false },
  { code: "GHB", name: "GKV: Hausbesuch (Preis/Position prüfen)", priceCents: 0, vatRate: 0, durationMin: 0, category: "travel", requiresTherapeuticPurpose: true, active: false },
];

export const SERVICE_TEMPLATES: Record<ServiceTemplateId, { label: string; description: string; services: () => TemplateService[] }> = {
  standard: {
    label: "Podologie Standard",
    description: "Komplexbehandlung, Hornhaut, Nägel, Spangen, Hausbesuch, Produkte – für die meisten Praxen der richtige Start.",
    services: fromDefaults,
  },
  selfpay: {
    label: "Nur Selbstzahler",
    description: "Standard-Katalog plus Wellness-/Kosmetikleistungen (19 % USt). Keine Kassenpositionen – Kassen-Themen werden ausgeblendet (änderbar unter Einstellungen → Praxisdaten).",
    services: () => [...fromDefaults(), ...SELFPAY_EXTRA],
  },
  gkv: {
    label: "Mit GKV-Positionen",
    description: "Standard-Katalog plus Kassenleistungen nach Heilmittelkatalog. Die GKV-Positionen werden inaktiv angelegt – bitte Positionsnummer und Vergütung eintragen und aktivieren.",
    services: () => [...fromDefaults(), ...GKV_EXTRA],
  },
};

export const isTemplateId = (v: unknown): v is ServiceTemplateId => v === "standard" || v === "selfpay" || v === "gkv";
