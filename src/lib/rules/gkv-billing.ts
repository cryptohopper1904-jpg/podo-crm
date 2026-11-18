/**
 * GKV Paket C – Abrechnungsangaben der Verordnung (§ 302 SGB V) und Absetzungen. Reine Regeln ohne DB.
 *
 * Quellen (gelesen am 18.11.2026):
 *  - [A3-302] GKV-Spitzenverband, Richtlinien nach § 302 SGB V, Anlage 3 „Schlüsselverzeichnisse“ Version 21,
 *    Stand 19.09.2025, anzuwenden ab 01.10.2025 – 8.1.11 (S. 27), 8.1.12 (S. 28), 8.1.17 (S. 35)
 *    https://www.gkv-datenaustausch.de/media/dokumente/leistungserbringer_1/sonstige_leistungserbringer/technische_anlagen_aktuell_4/Anlage_3_TP5_V21_20250919.pdf
 *  - HeilM-RL § 7 Abs. 1–6, § 8 Abs. 3, § 13a (Verweise aus 8.1.12/8.1.17, Wortlaut dort zitiert)
 */

const A3 = "Anlage 3 zu § 302 SGB V V21 (19.09.2025)";

/**
 * 8.1.12 Kennzeichen Verordnungsart bei Heilmitteln. Für Podologie angeboten: 03 und 04. „05“ (Blankoverordnung nach
 * § 13a HeilM-RL) gibt es laut HeilM-RL nicht für Podologie – nur dokumentiert, nicht wählbar (docs/GKV.md).
 */
export const PRESCRIPTION_KINDS = {
  "03": { label: "03 – Verordnung nach § 7 Abs. 1–5 HeilM-RL (orientierende Behandlungsmenge laut Heilmittelkatalog)", short: "03 orientierende Behandlungsmenge" },
  "04": { label: "04 – Verordnung nach § 7 Abs. 6 HeilM-RL (besonderer Verordnungsbedarf oder langfristiger Heilmittelbedarf)", short: "04 besonderer Verordnungsbedarf / langfristiger Heilmittelbedarf" },
} as const;
export type PrescriptionKind = keyof typeof PRESCRIPTION_KINDS;
export const PRESCRIPTION_KIND_CODES = Object.keys(PRESCRIPTION_KINDS) as PrescriptionKind[];
export const PRESCRIPTION_KIND_SOURCE = `${A3}, 8.1.12`;
export const isPrescriptionKind = (v: unknown): v is PrescriptionKind => typeof v === "string" && (PRESCRIPTION_KIND_CODES as string[]).includes(v);

/** 8.1.11 Kennzeichen Verordnungsbesonderheiten (Wortlaut Anlage 3; „3“ nicht belegt, „8“ nur Hilfsmittel) */
export const PRESCRIPTION_SPECIALS = {
  "1": "Verordnung von einem Zahnarzt/Kieferorthopäden",
  "2": "Verordnung im Zusammenhang mit der Schwangerschaft oder der Entbindung",
  "4": "Verordnung im Rahmen des Entlassmanagements",
  "7": "Verordnung im Rahmen der Terminservicestellen",
  "9": "Verordnung im Rahmen eines Modellvorhabens nach § 64d SGB V",
} as const;
export type PrescriptionSpecial = keyof typeof PRESCRIPTION_SPECIALS;
export const PRESCRIPTION_SPECIAL_CODES = Object.keys(PRESCRIPTION_SPECIALS) as PrescriptionSpecial[];
export const PRESCRIPTION_SPECIAL_SOURCE = `${A3}, 8.1.11`;
export const isPrescriptionSpecial = (v: unknown): v is PrescriptionSpecial => typeof v === "string" && (PRESCRIPTION_SPECIAL_CODES as string[]).includes(v);

/** 8.1.17 Art der Genehmigung, Bereich Heilmittel: nur B2 (Genehmigung eines langfristigen Heilmittelbedarfs, § 8 Abs. 3 HeilM-RL) */
export const APPROVAL_KIND = "B2" as const;
export const APPROVAL_SOURCE = `${A3}, 8.1.17; TA1 SKZ (Genehmigungskennzeichen ..20)`;
/** SKZ Genehmigungskennzeichen: AN, höchstens 20 Zeichen (TA1 V21 5.5.3.3). Zulässig: Buchstaben, Ziffern, - / . und Leerzeichen innen */
export const APPROVAL_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ./-]{0,18}[A-Za-z0-9])?$/;

export type KindSuggestion = { kind: PrescriptionKind; reason: string } | null;

/**
 * Vorschlag für das Kennzeichen Verordnungsart – nie automatisch gesetzt, immer durch Nutzer:innen zu bestätigen.
 * Belegt ist nur: Eine Genehmigung eines langfristigen Heilmittelbedarfs (B2, § 8 Abs. 3 HeilM-RL) betrifft eine
 * Verordnung nach § 7 Abs. 6 HeilM-RL → „04“. Die Diagnoselisten für besonderen Verordnungsbedarf bzw. langfristigen
 * Heilmittelbedarf (Anlage 2 HeilM-RL, KBV/GKV-Liste BVB) sind in PodoHero nicht hinterlegt → sonst kein Vorschlag
 * („bitte wählen“, Ärztin/Arzt hat das auf dem Muster 13 bestimmt).
 */
export function suggestPrescriptionKind(v: { approvalRef?: string | null }): KindSuggestion {
  if ((v.approvalRef ?? "").trim()) return { kind: "04", reason: "Genehmigung eines langfristigen Heilmittelbedarfs (B2) erfasst – Verordnung nach § 7 Abs. 6 HeilM-RL." };
  return null;
}

/** Fehlermeldung, wenn das Kennzeichen fehlt (Abrechnungsreife, Abrechnungslauf, § 302) */
export const KIND_MISSING = "Kennzeichen Verordnungsart (03/04) ist nicht bestätigt – bitte unter „Abrechnungsangaben“ an der Verordnung wählen.";

// ───────────────────────── Absetzungen / Retaxen ─────────────────────────

export const DEDUCTION_STATUSES = ["open", "accepted", "objected", "done"] as const;
export type DeductionStatus = (typeof DEDUCTION_STATUSES)[number];
export const DEDUCTION_STATUS_LABEL: Record<DeductionStatus, string> = {
  open: "offen",
  accepted: "akzeptiert",
  objected: "Widerspruch",
  done: "erledigt",
};
export const isDeductionStatus = (v: unknown): v is DeductionStatus => typeof v === "string" && (DEDUCTION_STATUSES as readonly string[]).includes(v);

/** Ausgang einer erledigten Absetzung (Pflicht bei „erledigt“, DB-CHECK gkv_deductions_outcome_check) */
export const DEDUCTION_OUTCOMES = ["upheld", "reversed"] as const;
export type DeductionOutcome = (typeof DEDUCTION_OUTCOMES)[number];
export const DEDUCTION_OUTCOME_LABEL: Record<DeductionOutcome, string> = {
  upheld: "Absetzung bleibt",
  reversed: "Widerspruch erfolgreich",
};
export const isDeductionOutcome = (v: unknown): v is DeductionOutcome => typeof v === "string" && (DEDUCTION_OUTCOMES as readonly string[]).includes(v);

/** erlaubte Statuswechsel (Trigger podo_gkv_deduction_guard: „erledigt“ ist abschließend) */
const DEDUCTION_TRANSITIONS: Record<DeductionStatus, readonly DeductionStatus[]> = {
  open: ["accepted", "objected", "done"],
  objected: ["accepted", "done", "open"],
  accepted: ["done", "objected"],
  done: [],
};
export function canChangeDeductionStatus(from: DeductionStatus, to: DeductionStatus): boolean {
  return from === to || DEDUCTION_TRANSITIONS[from].includes(to);
}

/** Höchstbetrag einer Absetzung (Plausibilität, Trigger-CHECK: 10.000 €) */
export const DEDUCTION_MAX_CENTS = 1_000_000;

/** noch nicht abgeschlossen = offen oder im Widerspruch (Auswertung „offene Absetzungen“) */
export const deductionPending = (status: string) => status === "open" || status === "objected";

/** Summen je Status (für Auswertung und Übersicht) */
export function deductionTotals(rows: readonly { status: string; amountCents: number }[]): Record<DeductionStatus, { count: number; cents: number }> & { pendingCents: number } {
  const out = Object.fromEntries(DEDUCTION_STATUSES.map((s) => [s, { count: 0, cents: 0 }])) as Record<DeductionStatus, { count: number; cents: number }>;
  for (const r of rows) {
    if (!isDeductionStatus(r.status)) continue;
    out[r.status].count += 1;
    out[r.status].cents += r.amountCents;
  }
  return { ...out, pendingCents: out.open.cents + out.objected.cents };
}

/** Steuerzeichen/Zeilenumbrüche aus Freitexten entfernen (Grund, Notiz) */
export function cleanText(v: string | null | undefined, max: number): string {
  return (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// ───────────────────────── Korrektur abgerechneter Verordnungen ─────────────────────────

/**
 * Spalten der Verordnung, die beim Vergleich mit dem Stand der Erstabrechnung (prescription_corrections.original_row)
 * nicht als inhaltliche Änderung zählen: Status und Altvermerk Zuzahlung (auch an abgerechneten Verordnungen änderbar).
 * Bestätigungszeitpunkt/-person des Kennzeichens zählen mit: Eine Neubestätigung im Korrekturstatus erzwingt die
 * Neuabrechnung (AppSec Runde 2, S3). Gleiche Liste im Trigger podo_prescription_billed_lock (Migration 0066).
 */
export const CORRECTION_VOLATILE_KEYS = ["status", "copayment_paid_at", "copayment_paid_cents", "copayment_paid_method"] as const;
/** abgeleitete Beträge (bei „abrechnungsreif“ neu berechnet) – bei „ohne Neuabrechnung“ aus der Erstabrechnung wiederhergestellt */
export const CORRECTION_DERIVED_KEYS = ["price_snapshot", "remedy_cost_cents", "copayment_cents"] as const;

const eur = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;

/**
 * Hinweis bei Neuabrechnung nach Korrektur, wenn sich das Zuzahlungs-Soll ändert – gegenüber der Erstabrechnung und
 * gegenüber schon quittierten Beträgen (gültige Zuzahlungsquittungen + Altvermerk). Nur Hinweis, keine Sperre: Erstattung
 * bzw. Nachforderung entscheidet die Praxis (Storno/neue Quittung). null = nichts zu melden.
 */
export function rebillCopaymentHint(newCents: number | null, originalCents: number | null, receiptedCents: number): string | null {
  const now = newCents ?? 0;
  const parts: string[] = [];
  if (originalCents !== null && originalCents !== now) parts.push(`Die Zuzahlung ändert sich gegenüber der Erstabrechnung von ${eur(originalCents)} auf ${eur(now)}.`);
  if (receiptedCents > 0 && receiptedCents !== now) {
    parts.push(receiptedCents > now ? `Quittiert sind ${eur(receiptedCents)} – ${eur(receiptedCents - now)} zu viel (Erstattung prüfen).` : `Quittiert sind ${eur(receiptedCents)} – ${eur(now - receiptedCents)} noch offen.`);
  }
  return parts.length ? parts.join(" ") : null;
}
