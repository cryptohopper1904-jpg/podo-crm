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
  return inv.kind !== "receipt" && inv.kind !== "deposit" && inv.kind !== "credit_note" && inv.status !== "paid" && inv.status !== "cancelled";
}

/** Fällig am Rechnungstag (Zahlungsziel 0 Tage) → „sofort“ statt Datum */
export const dueImmediately = (inv: { issuedAt?: string | null; dueAt: string | null }) => !!inv.dueAt && !!inv.issuedAt && inv.dueAt.slice(0, 10) <= inv.issuedAt.slice(0, 10);

/** Anzeige für „Zahlbar bis“ (Kasten auf dem Beleg) */
export const dueLabel = (inv: { issuedAt?: string | null; dueAt: string | null }, dateDe: (d: string | null) => string) => (dueImmediately(inv) ? "sofort" : dateDe(inv.dueAt));

/** Quittung (auch über eine Anzahlung): Beschriftung der Nummer und „Betrag dankend erhalten“. */
export const isReceiptLike = (kind: string) => kind === "receipt" || kind === "deposit";

export type CreditedDeposit = { number: string | null; issuedAt: string | null; totalCents: number; netCents?: number | null; vatCents?: number | null };

const euroDe = (cents: number) => `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/**
 * Summenzeilen nach dem Gesamtbetrag: angerechnete Anzahlungen (Quittungen) einzeln, danach die übrigen Zahlungen.
 * paidCents enthält die Anzahlungen (siehe createInvoice).
 * § 14 Abs. 5 S. 2 UStG: In der Endrechnung werden bei Anzahlungen mit USt auch deren Steuerbeträge abgesetzt –
 * deshalb je Anzahlung „netto … zzgl. USt …“ und danach die verbleibende USt.
 */
export function paymentSummary(inv: { kind: string; paidCents: number; vatCents?: number | null }, deposits: CreditedDeposit[], dateDe: (d: string | null) => string) {
  const rows: { label: string; cents: number }[] = deposits.map((d) => {
    const vat = d.vatCents ?? 0;
    const net = d.netCents ?? d.totalCents - vat;
    const rate = vat && net ? Math.round((vat * 100) / net) : 0;
    const tax = vat ? ` (netto ${euroDe(net)} zzgl. ${rate} % USt ${euroDe(vat)})` : "";
    return { label: `abzgl. Anzahlung ${d.number ?? ""} vom ${dateDe(d.issuedAt)}${tax}`, cents: -d.totalCents };
  });
  const depositCents = deposits.reduce((s, d) => s + d.totalCents, 0);
  const depositVat = deposits.reduce((s, d) => s + (d.vatCents ?? 0), 0);
  if (depositVat && inv.vatCents != null) rows.push({ label: "darin verbleibende USt", cents: inv.vatCents - depositVat });
  const rest = inv.paidCents - depositCents;
  if (rest !== 0) rows.push({ label: inv.kind === "credit_note" ? "erstattet/verrechnet" : deposits.length ? "weitere Zahlungen" : "bezahlt", cents: rest });
  return rows;
}

export const formatIban = (iban: string) => iban.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();

export const qtyDe = (s: string | number) => Number(s).toLocaleString("de-DE", { maximumFractionDigits: 2 });

/**
 * Überschrift und Leistungsdatum auf dem Beleg (§ 14 Abs. 4 Nr. 6 UStG: Zeitpunkt der Leistung bzw. bei Anzahlungen
 * der Vereinnahmung). Quellen, in dieser Reihenfolge:
 *  1. `serviceDates` – Tage der verknüpften Termine/Doku-Einträge (bei Storno: die der stornierten Rechnung)
 *     → „Rechnung zur Behandlung am 12.03.2026“ bzw. Zeitraum bei mehreren Tagen (Sammelrechnung)
 *  2. `inv.serviceDate` – im Formular ausdrücklich gesetztes Leistungsdatum (Positionen ohne Bezug, Standard =
 *     Rechnungsdatum) → neutrale Überschrift + „Leistungsdatum: …“ (kein „Behandlung“ behaupten, z. B. Produktverkauf)
 *  3. nichts (Altbestand vor dem Leistungsdatum-Feld) → der damals gedruckte Vorbehaltshinweis, unverändert
 * Anzahlung: kein Leistungsdatum, sondern Tag der Zahlung und – falls verknüpft – für welche Behandlung; liegt sie
 * nach dem Belegdatum, ist die Leistung noch nicht erbracht.
 */
export function invoiceHeading(
  inv: { kind: string; number: string | null; issuedAt: string | null; serviceDate?: string | null },
  serviceDates: string[],
  dateDe: (d: string | null) => string,
  cancelsNumber?: string | null,
): { heading: string; serviceDateNote: string | null } {
  const linked = [...new Set(serviceDates)].sort();
  const explicit = !linked.length && inv.serviceDate ? inv.serviceDate : null;
  const days = linked.length ? linked : explicit ? [explicit] : [];
  const when = (d: string[]) => (d.length > 1 ? `vom ${dateDe(d[0])} bis ${dateDe(d.at(-1)!)}` : `am ${dateDe(d[0])}`);
  const plain = (d: string[]) => (d.length > 1 ? `${dateDe(d[0])} bis ${dateDe(d.at(-1)!)}` : dateDe(d[0]));
  const legacyNote = "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben.";
  /** Rechnung/Quittung/Sammelrechnung: Überschrift mit Behandlungsdatum (verknüpft), sonst neutral + Leistungsdatum */
  const treatment = (title: string, rangeTitle: string) => {
    if (linked.length) return { heading: linked.length > 1 ? `${rangeTitle} ${when(linked)}` : `${title} zur Behandlung ${when(linked)}`, serviceDateNote: null };
    if (explicit) return { heading: title, serviceDateNote: `Leistungsdatum: ${dateDe(explicit)}` };
    return { heading: title, serviceDateNote: legacyNote };
  };
  switch (inv.kind) {
    case "invoice":
      return treatment("Rechnung", "Rechnung zur Behandlung im Zeitraum");
    case "receipt":
      return treatment("Quittung", "Quittung zur Behandlung im Zeitraum");
    case "collective":
      return treatment("Sammelrechnung", "Sammelrechnung für den Zeitraum");
    case "no_show_fee":
      // keine Leistung, sondern Entschädigung für den versäumten Termin – dessen Datum nennen
      return { heading: days.length === 1 ? `Ausfallhonorar für den Termin am ${dateDe(days[0])}` : "Ausfallhonorar", serviceDateNote: null };
    case "credit_note":
      return {
        heading: cancelsNumber ? `Stornorechnung zur Rechnung ${cancelsNumber}` : "Stornorechnung",
        serviceDateNote: days.length ? `Leistungsdatum der stornierten Rechnung: ${plain(days)}` : null,
      };
    case "deposit": {
      const paid = `Anzahlung erhalten am ${dateDe(inv.issuedAt)}`;
      if (!days.length) return { heading: "Quittung über eine Anzahlung", serviceDateNote: `${paid}. Die Leistung wird mit der Rechnung abgerechnet; das Leistungsdatum steht dort.` };
      const future = !!inv.issuedAt && days[0] > inv.issuedAt.slice(0, 10);
      return {
        heading: "Quittung über eine Anzahlung",
        serviceDateNote: `${paid} für die Behandlung ${when(days)}${future ? " – Leistung noch nicht erbracht" : ""}.`,
      };
    }
    default:
      return { heading: invoiceTitle(inv), serviceDateNote: days.length ? `Leistungsdatum: ${plain(days)}` : legacyNote };
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
  inv: { kind: string; status: string; number: string | null; issuedAt?: string | null; dueAt: string | null; totalCents: number; paidCents: number; paymentLinkUrl?: string | null },
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
  const due = dueImmediately(inv) ? " sofort" : inv.dueAt ? ` bis zum ${fmt.dateDe(inv.dueAt)}` : "";
  if (o.iban) {
    lines.push(`Zahlung per Überweisung: Bitte überweisen Sie ${inv.paidCents > 0 ? "den offenen Betrag" : "den Betrag"}${due} unter Angabe der Rechnungsnummer ${inv.number} auf das unten genannte Konto.`);
    if (opts.giroCode) lines.push("Tipp: Scannen Sie den GiroCode mit Ihrer Banking-App – Empfänger, Betrag und Verwendungszweck sind dann schon ausgefüllt.");
  } else {
    lines.push(`Zahlbar${due} ohne Abzug.`);
  }
  if (inv.paymentLinkUrl) lines.push(`Oder bequem online bezahlen: ${inv.paymentLinkUrl}`);
  return lines;
}
