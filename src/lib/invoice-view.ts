/**
 * Gemeinsame Darstellungslogik für Rechnungen – genutzt von der Druckansicht (rechnungen/[id])
 * und der PDF-Erzeugung (src/lib/invoice-pdf.ts), damit beide exakt gleich aussehen.
 * Keine Server-Importe.
 */
import { fullName } from "./format";
import { INTERNAL_NOTE_PREFIX, INVOICE_KIND_LABEL } from "./invoice-labels";

type Org = {
  name: string;
  legalName: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  smallBusiness: boolean;
};
type Person = { salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string; street?: string | null; zip?: string | null; city?: string | null };
type Contact = { name: string; street: string | null; zip: string | null; city: string | null };

export type InvoiceRecipient = { name: string; street: string | null; city: string; care: string | null };

export function invoiceRecipient(patient: Person | null, billing: Contact | null): InvoiceRecipient {
  if (billing) {
    return { name: billing.name, street: billing.street, city: [billing.zip, billing.city].filter(Boolean).join(" "), care: patient ? fullName(patient) : null };
  }
  if (patient) {
    return {
      name: [patient.salutation, fullName(patient)].filter(Boolean).join(" "),
      street: patient.street ?? null,
      city: [patient.zip, patient.city].filter(Boolean).join(" "),
      care: null,
    };
  }
  return { name: "–", street: null, city: "", care: null };
}

export const senderLine = (o: Org) => [o.legalName ?? o.name, o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

export function invoiceTitle(inv: { kind: string; number: string | null }) {
  return inv.kind === "credit_note" ? `Stornorechnung ${inv.number}` : `${INVOICE_KIND_LABEL[inv.kind]} ${inv.number}`;
}

/** Hinweiszeilen, die auf den Beleg gedruckt werden (interne Zeilen mit Präfix werden ausgelassen). */
export function publicNotes(notes: string | null | undefined): string {
  return (notes ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith(INTERNAL_NOTE_PREFIX))
    .join("\n");
}

export function internalNotes(notes: string | null | undefined): string[] {
  return (notes ?? "").split("\n").filter((l) => l.startsWith(INTERNAL_NOTE_PREFIX)).map((n) => n.slice(INTERNAL_NOTE_PREFIX.length));
}

/** § 4 Nr. 14 UStG-Hinweis nötig? */
export function hasExemptNote(o: Org, inv: { kind: string }, lines: { vatRate: number }[]) {
  return !o.smallBusiness && inv.kind !== "no_show_fee" && lines.some((l) => l.vatRate === 0);
}

/** „Zahlbar bis“ und Überweisungshinweis nur bei offenen Rechnungen (nicht bei Quittung/Anzahlung/Storno). */
export function showsDueDate(inv: { kind: string; status: string }) {
  return inv.kind !== "receipt" && inv.kind !== "deposit" && inv.kind !== "credit_note" && inv.status !== "paid";
}

/** Quittung (auch über eine Anzahlung): Beschriftung der Nummer und „Betrag dankend erhalten“. */
export const isReceiptLike = (kind: string) => kind === "receipt" || kind === "deposit";

export type CreditedDeposit = { number: string | null; issuedAt: string | null; totalCents: number };

/**
 * Summenzeilen nach dem Gesamtbetrag: angerechnete Anzahlungen (Quittungen) einzeln, danach die übrigen Zahlungen.
 * paidCents enthält die Anzahlungen (siehe createInvoice).
 */
export function paymentSummary(inv: { kind: string; paidCents: number }, deposits: CreditedDeposit[], dateDe: (d: string | null) => string) {
  const rows: { label: string; cents: number }[] = deposits.map((d) => ({ label: `abzgl. Anzahlung ${d.number ?? ""} vom ${dateDe(d.issuedAt)}`, cents: -d.totalCents }));
  const depositCents = deposits.reduce((s, d) => s + d.totalCents, 0);
  const rest = inv.paidCents - depositCents;
  if (rest !== 0) rows.push({ label: inv.kind === "credit_note" ? "erstattet/verrechnet" : deposits.length ? "weitere Zahlungen" : "bezahlt", cents: rest });
  return rows;
}

export const formatIban = (iban: string) => iban.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();

export const qtyDe = (s: string | number) => Number(s).toLocaleString("de-DE", { maximumFractionDigits: 2 });

/**
 * Überschrift auf dem Beleg (z. B. „Rechnung zur Behandlung am 09.11.2026“). Leistungsdaten stammen aus den
 * verknüpften Terminen/Doku-Einträgen; ohne Bezug gilt das Rechnungsdatum als Leistungsdatum.
 * `serviceDateNote` ist der Hinweis, wenn die Überschrift kein Leistungsdatum nennt.
 */
export function invoiceHeading(
  inv: { kind: string; number: string | null; issuedAt: string | null },
  serviceDates: string[],
  dateDe: (d: string | null) => string,
  cancelsNumber?: string | null,
): { heading: string; serviceDateNote: string | null } {
  const days = [...new Set(serviceDates)].sort();
  const span = days.length > 1 ? `vom ${dateDe(days[0])} bis ${dateDe(days.at(-1)!)}` : `am ${dateDe(days[0] ?? inv.issuedAt)}`;
  const defaultNote = days.length ? null : "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben.";
  switch (inv.kind) {
    case "invoice":
      return { heading: `Rechnung zur Behandlung ${days.length > 1 ? `im Zeitraum ${span}` : span}`, serviceDateNote: null };
    case "receipt":
      return { heading: `Quittung zur Behandlung ${days.length > 1 ? `im Zeitraum ${span}` : span}`, serviceDateNote: null };
    case "collective":
      return { heading: days.length > 1 ? `Sammelrechnung für den Zeitraum ${span}` : "Sammelrechnung", serviceDateNote: days.length > 1 ? null : defaultNote };
    case "no_show_fee":
      return { heading: days.length === 1 ? `Ausfallhonorar für den Termin am ${dateDe(days[0])}` : "Ausfallhonorar", serviceDateNote: null };
    case "credit_note":
      return { heading: cancelsNumber ? `Stornorechnung zur Rechnung ${cancelsNumber}` : "Stornorechnung", serviceDateNote: null };
    case "deposit":
      return { heading: "Quittung über eine Anzahlung", serviceDateNote: null };
    default:
      return { heading: invoiceTitle(inv), serviceDateNote: defaultNote };
  }
}

const METHOD_PHRASE: Record<string, string> = {
  cash: "in bar",
  card: "per Karte",
  transfer: "per Überweisung",
  voucher: "per Gutschein",
  payment_link: "online per Zahlungslink",
};

/**
 * Zahlungshinweis nach tatsächlichem Stand: bezahlt (mit Zahlart) · offen (Überweisung bis …) · Erstattung.
 * Gibt Zeilen zurück; leere Liste = kein Hinweis (z. B. Storno ohne Restbetrag).
 */
export function paymentNoteLines(
  inv: { kind: string; status: string; number: string | null; dueAt: string | null; totalCents: number; paidCents: number; paymentLinkUrl?: string | null },
  payments: { method: string; amountCents: number }[],
  o: { iban: string | null },
  fmt: { dateDe: (d: string | null) => string; money: (c: number) => string },
  opts: { giroCode: boolean } = { giroCode: false },
): string[] {
  if (inv.status === "cancelled" || inv.status === "draft") return [];
  const open = inv.totalCents - inv.paidCents;
  const methods = [...new Set(payments.filter((p) => p.amountCents > 0).map((p) => METHOD_PHRASE[p.method] ?? p.method))];
  const via = methods.length ? ` ${methods.join(" und ")}` : "";
  if (inv.kind === "credit_note") return open < 0 ? [`Der Betrag von ${fmt.money(-open)} wird Ihnen erstattet bzw. verrechnet.`] : [];
  if (open < 0) return [`Zu viel gezahlt: ${fmt.money(-open)} – wir erstatten Ihnen den Betrag.`];
  if (open === 0) {
    if (!inv.totalCents) return [];
    return [isReceiptLike(inv.kind) ? `Zahlung${via} – Betrag dankend erhalten.` : `Der Rechnungsbetrag wurde${via} bezahlt – vielen Dank.`];
  }
  const lines: string[] = [];
  if (inv.paidCents > 0) lines.push(`Bereits bezahlt${via}: ${fmt.money(inv.paidCents)}. Offen: ${fmt.money(open)}.`);
  const due = inv.dueAt ? ` bis zum ${fmt.dateDe(inv.dueAt)}` : "";
  if (o.iban) {
    lines.push(`Zahlung per Überweisung: Bitte überweisen Sie ${inv.paidCents > 0 ? "den offenen Betrag" : "den Betrag"}${due} unter Angabe der Rechnungsnummer ${inv.number} auf das unten genannte Konto.`);
    if (opts.giroCode) lines.push("Tipp: Scannen Sie den GiroCode mit Ihrer Banking-App – Empfänger, Betrag und Verwendungszweck sind dann schon ausgefüllt.");
  } else {
    lines.push(`Zahlbar${due} ohne Abzug.`);
  }
  if (inv.paymentLinkUrl) lines.push(`Oder bequem online bezahlen: ${inv.paymentLinkUrl}`);
  return lines;
}
