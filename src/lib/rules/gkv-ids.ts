/**
 * Kennungen der GKV-Abrechnung: Institutionskennzeichen (IK), Krankenversichertennummer (KVNR), lebenslange
 * Arztnummer (LANR), Betriebsstättennummer (BSNR), Versichertenstatus und Leistungserbringergruppenschlüssel (LEGS).
 * Reine Funktionen ohne DB/Uhr. Jede Regel nennt ihre Quelle (Dokument + Abschnitt); Übersicht in docs/GKV.md.
 */

const onlyDigits = (s: string) => /^\d+$/.test(s);
/** Quersumme einer ein- oder zweistelligen Zahl (Produkte 0…18) */
const crossSum = (n: number) => (n > 9 ? n - 9 : n);

/** Leerzeichen entfernen, Großbuchstaben (Eingaben wie „109 519 005“ oder „a123456780“) */
export function normalizeId(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, "").toUpperCase();
}

// ───────────────────────── Institutionskennzeichen ─────────────────────────

/**
 * Prüfziffer (Stelle 9) eines 9-stelligen IK. Verfahren: Stellen 3 bis 8 (Regionalbereich + Seriennummer, die
 * Klassifikation an Stelle 1–2 zählt nicht) von links abwechselnd mit 2, 1, 2, 1, 2, 1 multiplizieren, Quersummen
 * der Produkte addieren, Summe modulo 10 = Prüfziffer.
 * Quelle: GKV-Spitzenverband, Richtlinie nach § 290 SGB V, Anlage 1 „Prüfziffernberechnung für die
 * Krankenversichertennummer“ (Stand 02.01.2023), Rechenbeispiel IK 109911114 (Stellen 11–19: Faktoren 2 1 2 1 2 1
 * auf „991111“, Summe 24 → Prüfziffer 4) –
 * https://www.gkv-datenaustausch.de/media/dokumente/kvnr/Anlage_1_20230102_Pruefziffernberechnung-KVNR.pdf
 */
export function ikCheckDigit(first8: string): number {
  const body = first8.slice(2, 8);
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += crossSum(Number(body[i]) * (i % 2 === 0 ? 2 : 1));
  return sum % 10;
}

export function isValidIk(v: string | null | undefined): boolean {
  const ik = normalizeId(v);
  return ik.length === 9 && onlyDigits(ik) && ikCheckDigit(ik) === Number(ik[8]);
}

/** Meldung für ein IK-Feld (null = in Ordnung bzw. leer) */
export function ikProblem(v: string | null | undefined, label = "IK"): string | null {
  const ik = normalizeId(v);
  if (!ik) return null;
  if (ik.length !== 9 || !onlyDigits(ik)) return `${label} hat 9 Ziffern.`;
  if (!isValidIk(ik)) return `${label} ${ik}: Prüfziffer stimmt nicht – bitte Tippfehler prüfen.`;
  return null;
}

// ───────────────────────── Krankenversichertennummer ─────────────────────────

/**
 * Unveränderbarer Teil der KVNR (10 Stellen): Stelle 1 Großbuchstabe A–Z, Stellen 2–9 Zählnummer, Stelle 10 Prüfziffer.
 * Quelle Aufbau: Richtlinie zum Aufbau und zur Vergabe einer Krankenversichertennummer nach § 290 SGB V (Stand
 * 21.10.2025), Tabelle 1 und Zeilen 175–179 –
 * https://www.gkv-datenaustausch.de/media/dokumente/kvnr/Richtlinie_20251021_Gesamtsystem-KVNR__290_SGBV_3.4.1_fin.pdf
 * Quelle Prüfziffer: Anlage 1 (Stand 02.01.2023, s. o.): Buchstabe als zweistellige Zahl (A = 01 … Z = 26), die
 * dann 10 Ziffern abwechselnd mit 1, 2, 1, 2 … multiplizieren, Quersummen addieren, Summe modulo 10 = Prüfziffer
 * (Beispiele A000500015, C000500021).
 */
export function kvnrCheckDigit(first9: string): number {
  const letter = first9.charCodeAt(0) - 64;
  const digits = `${String(letter).padStart(2, "0")}${first9.slice(1, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += crossSum(Number(digits[i]) * (i % 2 === 0 ? 1 : 2));
  return sum % 10;
}

export function isValidKvnr(v: string | null | undefined): boolean {
  const k = normalizeId(v);
  return /^[A-Z]\d{9}$/.test(k) && kvnrCheckDigit(k) === Number(k[9]);
}

export function kvnrProblem(v: string | null | undefined): string | null {
  const k = normalizeId(v);
  if (!k) return null;
  if (!/^[A-Z]\d{9}$/.test(k)) return "Versichertennummer (KVNR): 1 Buchstabe + 9 Ziffern, z. B. A123456780.";
  if (!isValidKvnr(k)) return `Versichertennummer ${k}: Prüfziffer stimmt nicht – bitte prüfen.`;
  return null;
}

// ───────────────────────── Arzt- und Betriebsstättennummer ─────────────────────────

/**
 * LANR (9 Stellen) = Arztnummer (Stellen 1–6 Ziffernfolge, Stelle 7 Prüfziffer) + Fachgruppencode (Stellen 8–9).
 * Prüfziffer: Stellen 1–6 von links abwechselnd mit 4 und 9 multiplizieren, Summe modulo 10, Prüfziffer = 10 − Rest
 * (Differenz 10 → 0).
 * Quelle: Vereinbarung gemäß § 293 Absätze 4 und 7 SGB V über eine zentrale Arztnummernvergabe (ANRV) vom
 * 17.10.2018, § 4 Abs. 2 bis 4 –
 * https://www.kbv.de/documents/infothek/rechtsquellen/weitere-vertraege/praxen/arzt-und-betriebsstaettennummer/ANRV-Vereinbarung.pdf
 */
export function lanrCheckDigit(first6: string): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(first6[i]) * (i % 2 === 0 ? 4 : 9);
  const d = 10 - (sum % 10);
  return d === 10 ? 0 : d;
}

export function isValidLanr(v: string | null | undefined): boolean {
  const l = normalizeId(v);
  return /^\d{9}$/.test(l) && lanrCheckDigit(l) === Number(l[6]);
}

/**
 * Prüfziffer falsch → nur Warnung „bitte prüfen“: Ersatz-/Pseudonummern (z. B. Krankenhaus, Vertretung) folgen dem
 * Verfahren nicht zwingend; eine Regel dazu haben wir nicht belegt (docs/GKV.md, offene Punkte).
 */
export function lanrProblem(v: string | null | undefined): string | null {
  const l = normalizeId(v);
  if (!l) return null;
  if (!/^\d{9}$/.test(l)) return "LANR hat 9 Ziffern.";
  if (!isValidLanr(l)) return `LANR ${l}: Prüfziffer (7. Stelle) passt nicht – bitte mit dem Arztstempel vergleichen.`;
  return null;
}

/**
 * BSNR: 9 Ziffern, Stellen 1–2 KV-Landes-/Bezirksstelle. Eine Prüfziffer ist in den gelesenen Quellen NICHT
 * festgelegt – daher nur Formatprüfung (docs/GKV.md, offene Punkte).
 */
export function bsnrProblem(v: string | null | undefined): string | null {
  const b = normalizeId(v);
  if (!b) return null;
  return /^\d{9}$/.test(b) ? null : "BSNR hat 9 Ziffern.";
}

// ───────────────────────── Versichertenstatus ─────────────────────────

/**
 * Versichertenart (1. Stelle des Feldes „Status“ im Personalienfeld): 1 = Mitglied, 3 = Familienangehöriger,
 * 5 = Rentner.
 * Quelle: Technische Anlage zum Vertrag über den Datenaustausch (Anlage 6 BMV-Ä), Version 1.23 vom 03.06.2024,
 * Abschnitt 4.4.1 Feld 6/6.2.1 „Versichertenart“ –
 * https://www.gkv-datenaustausch.de/media/dokumente/leistungserbringer_1/aerzte/technische_anlagen___archiv/20240603_TA1_23.pdf
 */
export const INSURED_STATUS = { "1": "Mitglied", "3": "Familienversichert", "5": "Rentner:in" } as const;
export type InsuredStatus = keyof typeof INSURED_STATUS;
export const INSURED_STATUS_CODES = Object.keys(INSURED_STATUS) as InsuredStatus[];
export const isInsuredStatus = (v: unknown): v is InsuredStatus => typeof v === "string" && Object.hasOwn(INSURED_STATUS, v);

/**
 * Versichertenstatus aus Fremddaten (Pododesk „versichertenstatus“, eVerordnung): Ziffer am Anfang („1“, „1000000“,
 * „5 Rentner“) oder Klartext. Unbekannt → null (nicht raten).
 */
export function parseInsuredStatus(v: unknown): InsuredStatus | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim().toLowerCase();
  const d = /^([135])(\d{0,6})?(\s|$)/.exec(s)?.[1];
  if (d) return d as InsuredStatus;
  if (/^mitglied/.test(s)) return "1";
  if (/^famil/.test(s)) return "3";
  if (/^rentner/.test(s)) return "5";
  return null;
}

// ───────────────────────── Leistungserbringergruppenschlüssel ─────────────────────────

/**
 * 7-stelliger Schlüssel „Leistungserbringergruppe“ (LEGS) Podologie und Status für die Positionsnummer (ZL/KH/KB).
 * Quelle: Anlage 2 Vergütung zum Vertrag nach § 125 Abs. 1 SGB V Podologie i. d. F. vom 01.07.2025, § 1 Abs. 1 und 2 –
 * https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_2.pdf
 * Pflicht in der Abrechnung: Vertrag nach § 125 Abs. 1 SGB V Podologie (Lesefassung bis 16.06.2025), § 18 Abs. 7.
 */
export const LEGS_PODOLOGIE = {
  "7100501": { label: "Podolog:innen", status: "ZL" },
  "7200501": { label: "Med. Fußpfleger:innen (§ 10 Abs. 4 bis 6 PodG)", status: "ZL" },
  "2700541": { label: "Krankenhaus", status: "KH" },
  "2800541": { label: "Kurbetrieb", status: "KB" },
} as const;
export type LegsCode = keyof typeof LEGS_PODOLOGIE;
export const LEGS_CODES = Object.keys(LEGS_PODOLOGIE) as LegsCode[];
export const isLegsCode = (v: unknown): v is LegsCode => typeof v === "string" && Object.hasOwn(LEGS_PODOLOGIE, v);
/** Status für die Positionsnummer: ZL (zugelassene LE), KH (Krankenhaus), KB (Kurbetrieb) */
export type ProviderStatus = "ZL" | "KH" | "KB";
export function providerStatusOf(legs: string | null | undefined): ProviderStatus {
  return isLegsCode(legs) ? LEGS_PODOLOGIE[legs].status : "ZL";
}
