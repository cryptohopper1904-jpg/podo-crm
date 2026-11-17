/**
 * Bundeseinheitliche Vergütung Podologie (GKV) – versionierte Preistabelle.
 *
 * Quelle (vollständig gelesen am 17.11.2026): GKV-Spitzenverband, „Anlage 2: Vergütung zum Vertrag nach § 125 Absatz 1
 * SGB V über die Versorgung mit Leistungen der Podologie“ i. d. F. vom 01.07.2025 (unterzeichnet 16.06.2025) –
 * https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_2.pdf
 *   § 2 Preisvereinbarung ab dem 01.07.2025 (Behandlungen ab 01.07.2025), Buchstaben a–e
 *   § 3 Preisvereinbarung ab dem 01.07.2026 (Behandlungen ab 01.07.2026), Buchstaben a–e
 *   § 1 Abs. 2: Positionsnummer je Status – ZL (zugelassene LE, 78xxx/79xxx), KH (Krankenhaus, 68xxx/69xxx),
 *   KB (Kurbetrieb, 88xxx/89xxx). Die Tabelle nennt je Position alle drei Nummern; sie unterscheiden sich durchgehend
 *   nur in der ersten Ziffer (7 → 6 bzw. 8), Preise sind gleich.
 *   „davon Zuzahlung (nachrichtlich)“ = 10 % je Position, wie in der Tabelle angegeben (78220 und 78530: ohne).
 *
 * Maßgeblich ist das BEHANDLUNGSDATUM („Für Behandlungen, die ab dem … stattfinden“, § 2 Abs. 2 / § 3 Abs. 2).
 * Für Behandlungen vor dem 01.07.2025 ist hier KEIN Preis hinterlegt (ältere Anlage nicht ausgewertet) → null.
 * Neue Fassung: Version unten anhängen (gültig ab), nie bestehende Werte ändern – Verordnungen speichern beim
 * Abrechnungsreif-Setzen einen Preis-Snapshot mit `tableVersion`.
 */
import type { ProviderStatus } from "./gkv-ids";

export const VERGUETUNG_SOURCE =
  "GKV-Spitzenverband, Podologie Anlage 2 Vergütung i. d. F. vom 01.07.2025 (§ 2 ab 01.07.2025, § 3 ab 01.07.2026)";
export const VERGUETUNG_URL =
  "https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_2.pdf";

/** Gruppe der Diagnosegruppen, für die eine Position gilt (Anlage 2 § 2 Abs. 2 Buchst. a bzw. b–d) */
export type PositionFamily = "DF_NF_QF" | "UI" | "home_visit";

export type GkvPosition = {
  /** Positionsnummer für zugelassene Leistungserbringer (ZL) */
  hpnr: string;
  label: string;
  family: PositionFamily;
  /** nur UI: Positionen nach Buchst. b nur für Verordnungen bis 30.09.2025, nach Buchst. c ab 01.10.2025 */
  issuedUntil?: string;
  issuedFrom?: string;
  /** Anlage 2 § 2 Abs. 2 Buchst. c: 78610 „dürfen zweimal je Tag abgegeben werden“ */
  maxPerDay?: number;
};

export const GKV_POSITIONS: GkvPosition[] = [
  // § 2 Abs. 2 a) Diagnosegruppen DF / NF / QF
  { hpnr: "78010", label: "Podologische Behandlung (klein)", family: "DF_NF_QF" },
  { hpnr: "78020", label: "Podologische Behandlung (groß)", family: "DF_NF_QF" },
  { hpnr: "78030", label: "Podologische Befundung", family: "DF_NF_QF" },
  { hpnr: "78040", label: "Eingangsbefundung", family: "DF_NF_QF" },
  // § 2 Abs. 2 b) UI1/UI2, Verordnungsdatum bis 30.09.2025
  { hpnr: "78210", label: "Anpassung einer einteiligen uni-/bilateralen Nagelkorrekturspange (z. B. Ross Fraser)", family: "UI", issuedUntil: "2025-09-30" },
  { hpnr: "78220", label: "Fertigung einer einteiligen uni-/bilateralen Nagelkorrekturspange (z. B. Ross Fraser)", family: "UI", issuedUntil: "2025-09-30" },
  { hpnr: "78230", label: "Nachregulierung der einteiligen uni-/bilateralen Nagelkorrekturspange", family: "UI", issuedUntil: "2025-09-30" },
  { hpnr: "78300", label: "Vorbereitung, Anpassung und Aufsetzen einer mehrteiligen bilateralen Nagelkorrekturspange", family: "UI", issuedUntil: "2025-09-30" },
  { hpnr: "78400", label: "Vorbereitung, Anpassung und Aufsetzen einer einteiligen Kunststoff-/Metall-Nagelkorrekturspange", family: "UI", issuedUntil: "2025-09-30" },
  // § 2 Abs. 2 c) UI1/UI2, Verordnungsdatum ab 01.10.2025
  { hpnr: "78610", label: "Nagelspangenbehandlung", family: "UI", issuedFrom: "2025-10-01", maxPerDay: 2 },
  { hpnr: "78620", label: "Aufschlag für besonderen Aufwand", family: "UI", issuedFrom: "2025-10-01" },
  // § 2 Abs. 2 d) UI1/UI2 unabhängig vom Verordnungsdatum
  { hpnr: "78100", label: "Erstbefundung groß", family: "UI" },
  { hpnr: "78110", label: "Erstbefundung klein", family: "UI" },
  { hpnr: "78510", label: "Indikationsspezifische Kontrolle auf Sitz- und Passgenauigkeit", family: "UI" },
  { hpnr: "78520", label: "Behandlungsabschluss / Entfernung der Nagelkorrekturspange", family: "UI" },
  { hpnr: "78530", label: "Therapiebericht UI 2", family: "UI" },
  // § 2 Abs. 2 e) Hausbesuche (inkl. Wegegeld)
  { hpnr: "79933", label: "Hausbesuch, ärztlich verordnet, inkl. Wegegeld", family: "home_visit" },
  { hpnr: "79934", label: "Hausbesuch in sozialer Einrichtung, inkl. Wegegeld", family: "home_visit" },
];

type Price = { cents: number; copayCents: number | null };
export type PriceVersion = { id: string; validFrom: string; section: string; prices: Record<string, Price> };

const p = (euro: number, copayEuro: number | null): Price => ({ cents: Math.round(euro * 100), copayCents: copayEuro === null ? null : Math.round(copayEuro * 100) });

/** Aufsteigend nach validFrom. Werte 1:1 aus der Anlage (Vergütung / davon Zuzahlung nachrichtlich). */
export const PRICE_VERSIONS: PriceVersion[] = [
  {
    id: "podo-anlage2-2025-07-01",
    validFrom: "2025-07-01",
    section: "Anlage 2 § 2 Abs. 2 (Preisvereinbarung ab dem 01.07.2025)",
    prices: {
      "78010": p(35.16, 3.52),
      "78020": p(50.55, 5.06),
      "78030": p(3.47, 0.35),
      "78040": p(22.48, 2.25),
      "78210": p(99.04, 9.9),
      "78220": p(54.24, null),
      "78230": p(49.64, 4.96),
      "78300": p(97.64, 9.76),
      "78400": p(53.89, 5.39),
      "78610": p(55.9, 5.59),
      "78620": p(16.86, 1.69),
      "78100": p(56.0, 5.6),
      "78110": p(27.9, 2.79),
      "78510": p(17.21, 1.72),
      "78520": p(25.91, 2.59),
      "78530": p(16.86, null),
      "79933": p(23.61, 2.36),
      "79934": p(13.6, 1.36),
    },
  },
  {
    id: "podo-anlage2-2026-07-01",
    validFrom: "2026-07-01",
    section: "Anlage 2 § 3 Abs. 2 (Preisvereinbarung ab dem 01.07.2026)",
    prices: {
      "78010": p(36.1, 3.61),
      "78020": p(51.92, 5.19),
      "78030": p(3.57, 0.36),
      "78040": p(23.11, 2.31),
      "78210": p(101.65, 10.17),
      "78220": p(55.66, null),
      "78230": p(50.95, 5.1),
      "78300": p(99.9, 9.99),
      "78400": p(55.2, 5.52),
      "78610": p(57.2, 5.72),
      "78620": p(17.33, 1.73),
      "78100": p(57.52, 5.75),
      "78110": p(28.63, 2.86),
      "78510": p(17.64, 1.76),
      "78520": p(26.59, 2.66),
      "78530": p(17.33, null),
      "79933": p(25.54, 2.55),
      "79934": p(16.66, 1.67),
    },
  },
];

/** Hausbesuchs-Positionen (Anlage 2 § 2 Abs. 2 Buchst. e) – nur abrechenbar mit „Hausbesuch: ja“ (Anlage 3 Buchst. c) */
export const HOME_VISIT_HPNR = ["79933", "79934"] as const;

/**
 * Positionsnummer (beliebiger Status) → ZL-Nummer. KH (6xxxx) und KB (8xxxx) unterscheiden sich laut Anlage 2 nur in
 * der ersten Ziffer. Unbekannt → null.
 */
export function toZlHpnr(hpnr: string | null | undefined): string | null {
  const h = (hpnr ?? "").trim();
  if (!/^[678]\d{4}$/.test(h)) return null;
  const zl = `7${h.slice(1)}`;
  return GKV_POSITIONS.some((x) => x.hpnr === zl) ? zl : null;
}

/** ZL-Nummer → Nummer für den Status der Praxis (Anlage 2 § 1 Abs. 2) */
export function hpnrFor(zlHpnr: string, status: ProviderStatus): string {
  return status === "KH" ? `6${zlHpnr.slice(1)}` : status === "KB" ? `8${zlHpnr.slice(1)}` : zlHpnr;
}

export function positionInfo(hpnr: string | null | undefined): GkvPosition | null {
  const zl = toZlHpnr(hpnr);
  return zl ? (GKV_POSITIONS.find((x) => x.hpnr === zl) ?? null) : null;
}

/** Preisversion für ein Behandlungsdatum (JJJJ-MM-TT); vor der ersten hinterlegten Version → null */
export function priceVersionFor(dateIso: string): PriceVersion | null {
  let hit: PriceVersion | null = null;
  for (const v of PRICE_VERSIONS) if (v.validFrom <= dateIso) hit = v;
  return hit;
}

export type PriceLookup = { cents: number; copayCents: number | null; version: string; validFrom: string; section: string } | null;

/** Vergütung einer Position am Behandlungstag (null = Position unbekannt oder kein Preis für dieses Datum) */
export function priceFor(hpnr: string | null | undefined, dateIso: string): PriceLookup {
  const zl = toZlHpnr(hpnr);
  const v = priceVersionFor(dateIso);
  if (!zl || !v) return null;
  const pr = v.prices[zl];
  return pr ? { ...pr, version: v.id, validFrom: v.validFrom, section: v.section } : null;
}

/**
 * Passt die Position zur Diagnosegruppe und zum Verordnungsdatum? (Anlage 2 § 2 Abs. 2: Buchst. a nur DF/NF/QF,
 * b–d nur UI1/UI2, b nur Verordnungen bis 30.09.2025, c nur ab 01.10.2025; e Hausbesuche für alle.)
 */
export function positionFits(hpnr: string, group: string, issuedAt: string): { ok: true } | { ok: false; reason: string } {
  const info = positionInfo(hpnr);
  if (!info) return { ok: false, reason: `Position ${hpnr} steht nicht in der Vergütungsliste Podologie.` };
  const ui = group === "UI1" || group === "UI2";
  if (info.family === "DF_NF_QF" && ui) return { ok: false, reason: `Position ${hpnr} gilt nur für DF/NF/QF, nicht für ${group}.` };
  if (info.family === "UI" && !ui) return { ok: false, reason: `Position ${hpnr} gilt nur für UI1/UI2 (Nagelspange), nicht für ${group}.` };
  if (info.issuedUntil && issuedAt > info.issuedUntil) return { ok: false, reason: `Position ${hpnr} gilt nur für Verordnungen bis ${info.issuedUntil.split("-").reverse().join(".")}.` };
  if (info.issuedFrom && issuedAt < info.issuedFrom) return { ok: false, reason: `Position ${hpnr} gilt erst für Verordnungen ab ${info.issuedFrom.split("-").reverse().join(".")}.` };
  return { ok: true };
}

/** Positionen für die Auswahl (Leistungskatalog, Verordnungsformular), gefiltert nach Diagnosegruppe */
export function positionsForGroup(group?: string | null): GkvPosition[] {
  if (!group) return GKV_POSITIONS;
  const ui = group === "UI1" || group === "UI2";
  return GKV_POSITIONS.filter((x) => x.family === "home_visit" || (ui ? x.family === "UI" : x.family === "DF_NF_QF"));
}
