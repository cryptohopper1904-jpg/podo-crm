/**
 * Positionen der Sammelrechnung aus angerechneten Teilrechnungen (Anzahlungs-Quittungen AZ… und normale Quittungen Q…).
 * Reine Funktionen ohne Server-Importe – genutzt vom Rechnungsformular (src/app/(app)/rechnungen/invoice-form.tsx).
 */
import { depositLineText } from "./deposit-lines";
import { dateDe } from "./format";

/** Noch nicht angerechnete Anzahlungen (Quittungen) – werden auf Rechnung/Sammelrechnung derselben Person angerechnet. */
export type OpenDeposit = {
  id: string;
  patientId: string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  /** Leistung laut Quittung (wird bei Auswahl als Position der Sammelrechnung übernommen) */
  description: string;
  vatRate: number;
  appointmentId: string | null;
  treatmentRecordId: string | null;
};

/**
 * Bezahlte normale Quittung (Teilrechnung) der Person, noch auf keiner Sammelrechnung – wird mit allen Positionen in die
 * Sammelrechnung übernommen und als „bereits bezahlt“ angerechnet (siehe openReceiptsFor in src/server/invoices.ts).
 */
export type OpenReceipt = {
  id: string;
  patientId: string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  vatCents: number;
  lines: {
    description: string;
    quantity: number;
    factor: number;
    unitPriceCents: number;
    vatRate: number;
    totalCents: number;
    appointmentId: string | null;
    treatmentRecordId: string | null;
    /** Leistungsdatum (Termin/Doku-Eintrag, sonst Quittungsdatum) */
    serviceDate: string | null;
  }[];
};

/** Position im Formular (Eingabewerte als Text) */
export type Line = {
  key: string;
  /** aus diesen Anzahlungen bzw. dieser Quittung übernommen (fällt beim Abwählen wieder weg) */
  depositIds?: string[];
  /** Position einer normalen Quittung (eine Quittung kann mehrere haben) */
  fromReceipt?: boolean;
  treatmentRecordId?: string | null;
  appointmentId?: string | null;
  serviceId: string;
  description: string;
  quantity: string;
  factor: string;
  price: string;
  vatRate: number;
  /** Eingabe im Kürzel-Feld (sonst Kürzel der gewählten Leistung) */
  codeInput?: string;
  /** Stand vor der Kürzel-Eingabe (für unbekannte Kürzel) */
  codeStart?: { serviceId: string; description: string; price: string; vatRate: number };
};

let seq = 0;
export const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
export const isEmptyLine = (l: Line) => !l.serviceId && !l.description.trim() && !l.price.trim() && !l.treatmentRecordId && !l.appointmentId;

export const newLine = (patch: Partial<Line> = {}): Line => ({
  key: `l${++seq}`,
  serviceId: "",
  description: "",
  quantity: "1",
  factor: "1",
  price: "",
  vatRate: 0,
  ...patch,
});

/**
 * Text einer übernommenen Quittungs-Position: Leistungsdatum voran (sofern der Text noch kein Datum nennt) und die
 * Quittungsnummer dahinter – „03.02.2026: Nagelspange – abgerechnet mit Quittung Q2026-0004“.
 */
export function receiptLineText(l: { description: string; serviceDate: string | null }, receiptNumber: string | null): string {
  const text = /\d{2}\.\d{2}\.\d{4}/.test(l.description) ? l.description : `${dateDe(l.serviceDate)}: ${l.description}`;
  const suffix = receiptNumber ? ` – abgerechnet mit Quittung ${receiptNumber}` : "";
  return `${text.slice(0, 300 - suffix.length)}${suffix}`;
}

/**
 * Positionen passend zu den gewählten Quittungen.
 * - Normale Quittungen (Teilrechnungen): alle ihre Positionen mit Preis, Menge, Faktor, USt und Termin-/Doku-Bezug.
 *   Bewusst als Freitext ohne Leistung/Produkt (serviceId leer): so bleibt der bezahlte Preis, auch wenn sich der
 *   Katalogpreis geändert hat, und ein Produkt wird nicht ein zweites Mal vom Lager abgebucht – das geschah schon mit
 *   der Quittung.
 * - Anzahlungen: eine Position je Behandlung – mehrere Anzahlungen zum selben Termin ergeben eine Position mit der Summe.
 * Steht eine Behandlung schon als eigene Position drin (Termin/Doku aus dem Jahresvorschlag oder aus einer ANDEREN
 * Quittung), wird sie nicht noch einmal übernommen (nie doppelt), nur angerechnet. Mehrere Positionen derselben Quittung
 * zum selben Termin (z. B. Behandlung + Nagelspange) bleiben alle erhalten. Unveränderte Auswahl behält vorhandene
 * (ggf. bearbeitete) Zeilen.
 */
export function syncDepositLines(ls: Line[], chosen: OpenDeposit[], chosenReceipts: OpenReceipt[] = []): Line[] {
  const others = ls.filter((l) => !l.depositIds?.length);
  const existing = ls.filter((l) => l.depositIds?.length);
  const covers = (list: { appointmentId?: string | null; treatmentRecordId?: string | null }[], x: { appointmentId: string | null; treatmentRecordId: string | null }) =>
    list.some((l) => (!!x.appointmentId && l.appointmentId === x.appointmentId) || (!!x.treatmentRecordId && l.treatmentRecordId === x.treatmentRecordId));
  const receiptLines: Line[] = [];
  for (const r of chosenReceipts) {
    const prev = existing.filter((l) => l.fromReceipt && l.depositIds![0] === r.id);
    if (prev.length) {
      receiptLines.push(...prev);
      continue;
    }
    // nur gegen eigene Positionen und Positionen ANDERER Quittungen prüfen – nie gegen die eigenen Zeilen dieser Quittung
    const blocking = [...others, ...receiptLines];
    for (const rl of r.lines) {
      if (covers(blocking, rl)) continue;
      receiptLines.push(
        newLine({
          depositIds: [r.id],
          fromReceipt: true,
          appointmentId: rl.appointmentId,
          treatmentRecordId: rl.treatmentRecordId,
          description: receiptLineText(rl, r.number),
          quantity: String(rl.quantity).replace(".", ","),
          factor: String(rl.factor).replace(".", ","),
          price: euro(rl.unitPriceCents),
          vatRate: rl.vatRate,
        }),
      );
    }
  }
  const groups = new Map<string, OpenDeposit[]>();
  for (const d of chosen) {
    if (covers([...others, ...receiptLines], d)) continue;
    const key = `${d.appointmentId ?? d.treatmentRecordId ?? d.id}|${d.vatRate}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const depLines = [...groups.values()].map((g) => {
    const ids = g.map((d) => d.id);
    const prev = existing.find((l) => !l.fromReceipt && sameIds(l.depositIds!, ids));
    if (prev) return prev;
    const d = g[0];
    return newLine({
      depositIds: ids,
      appointmentId: d.appointmentId,
      treatmentRecordId: d.treatmentRecordId,
      description: depositLineText(d),
      price: euro(g.reduce((s, x) => s + x.totalCents, 0)),
      vatRate: d.vatRate,
    });
  });
  const added = [...receiptLines, ...depLines];
  const result = [...(added.length ? others.filter((l) => !isEmptyLine(l)) : others), ...added];
  return result.length ? result : [newLine()];
}
