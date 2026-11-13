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

/** Leistungsangaben eines Belegs für die Überschrift (loadInvoiceBundle → invoiceService) */
export type InvoiceService = {
  /** Leistungstage: [Tag] oder [erster, letzter Tag]; leer = unbekannt (Altbeleg) */
  dates: string[];
  /** Positionen mit Termin-/Doku-Bezug → „zur Behandlung am …“ statt neutralem „Leistungsdatum: …“ */
  linked: boolean;
  /**
   * Leistungsangabe beim Ausstellen festgeschrieben (invoices.service_date_fixed). false = Altbeleg: wird exakt wie
   * damals gedruckt (Neudruck darf nicht anders aussehen) – siehe legacyHeading.
   */
  fixed: boolean;
  /** Storno: der stornierte Beleg (Art und Datum für Anzahlung/Ausfallhonorar) */
  cancels?: { number: string | null; kind: string; issuedAt: string | null } | null;
};

/** Leistungsangaben aus den Belegdaten (loadInvoiceBundle bzw. InvoicePdfData) */
export function invoiceService(data: {
  invoice: { serviceDateFixed?: boolean | null };
  serviceDates?: string[];
  serviceLinked?: boolean;
  cancels?: { number: string | null; kind?: string; issuedAt?: string | null } | null;
}): InvoiceService {
  const c = data.cancels;
  return {
    dates: data.serviceDates ?? [],
    linked: !!data.serviceLinked,
    fixed: !!data.invoice.serviceDateFixed,
    cancels: c ? { number: c.number, kind: c.kind ?? "invoice", issuedAt: c.issuedAt ?? null } : null,
  };
}

/**
 * Leistungstage eines Belegs: festgeschriebene Felder (service_date … service_date_to); nur bei Altbelegen ohne diese
 * Felder die Tage der verknüpften Termine/Doku-Einträge (`legacyLinked`).
 */
export function serviceDays(inv: { serviceDate?: string | null; serviceDateTo?: string | null }, legacyLinked: string[] = []): string[] {
  if (inv.serviceDate) return inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDate ? [inv.serviceDate, inv.serviceDateTo] : [inv.serviceDate];
  const days = [...new Set(legacyLinked)].sort();
  return days.length > 1 ? [days[0], days.at(-1)!] : days;
}

/**
 * Leistungszeitraum, der beim Ausstellen festgeschrieben wird: Tage der verknüpften Termine/Doku-Einträge und – bei
 * Positionen ohne Bezug – das Formular-Datum (ggf. bis …) gemeinsam, als erster/letzter Tag.
 */
export function serviceRange(linkedDays: string[], free: { from: string; to?: string | null } | null): { from: string; to: string | null } | null {
  const days = [...linkedDays, ...(free ? [free.from, free.to ?? free.from] : [])].sort();
  if (!days.length) return null;
  const from = days[0];
  const to = days.at(-1)!;
  return { from, to: to === from ? null : to };
}

/**
 * Überschrift und Leistungsdatum auf dem Beleg (§ 14 Abs. 4 Nr. 6 UStG: Zeitpunkt der Leistung, § 31 Abs. 4 UStDV:
 * Zeitraum genügt; bei Anzahlungen Zeitpunkt der Vereinnahmung).
 *  - mit Termin-/Doku-Bezug → „Rechnung zur Behandlung am 12.03.2026“ bzw. „im Zeitraum vom … bis …“
 *  - ohne Bezug → neutrale Überschrift + „Leistungsdatum: …“ bzw. „Leistungszeitraum: … bis …“
 *  - Altbeleg ohne Angaben → der damals gedruckte Vorbehaltshinweis, unverändert
 *  - Anzahlung → Tag der Zahlung, ggf. für welche Behandlung; liegt sie danach: „Leistung noch nicht erbracht“
 *  - Ausfallhonorar → Datum des versäumten Termins (keine Leistung)
 *  - Storno → Angabe des stornierten Belegs (Leistungsdatum, Anzahlung vom …, Termin am …)
 */
export function invoiceHeading(
  inv: { kind: string; number: string | null; issuedAt: string | null },
  service: InvoiceService,
  dateDe: (d: string | null) => string,
): { heading: string; serviceDateNote: string | null } {
  if (!service.fixed) return legacyHeading(inv, service.dates, dateDe, service.cancels?.number);
  const days = [...new Set(service.dates)].sort();
  const range = days.length > 1;
  const when = range ? `vom ${dateDe(days[0])} bis ${dateDe(days.at(-1)!)}` : `am ${dateDe(days[0] ?? null)}`;
  const plain = range ? `${dateDe(days[0])} bis ${dateDe(days.at(-1)!)}` : dateDe(days[0] ?? null);
  const legacyNote = "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben.";
  const treatment = (title: string, rangeTitle: string) => {
    if (!days.length) return { heading: title, serviceDateNote: legacyNote };
    if (service.linked) return { heading: range ? `${rangeTitle} ${when}` : `${title} zur Behandlung ${when}`, serviceDateNote: null };
    return { heading: title, serviceDateNote: range ? `Leistungszeitraum: ${plain}` : `Leistungsdatum: ${plain}` };
  };
  switch (inv.kind) {
    case "invoice":
      return treatment("Rechnung", "Rechnung zur Behandlung im Zeitraum");
    case "receipt":
      return treatment("Quittung", "Quittung zur Behandlung im Zeitraum");
    case "collective":
      return treatment("Sammelrechnung", "Sammelrechnung für den Zeitraum");
    case "no_show_fee":
      return { heading: days.length && !range ? `Ausfallhonorar für den Termin am ${dateDe(days[0])}` : "Ausfallhonorar", serviceDateNote: null };
    case "credit_note": {
      const c = service.cancels;
      const heading = c?.number ? `Stornorechnung zur ${c.kind === "deposit" ? "Anzahlung" : "Rechnung"} ${c.number}` : "Stornorechnung";
      if (c?.kind === "deposit") return { heading, serviceDateNote: c.issuedAt ? `Storno der Anzahlung vom ${dateDe(c.issuedAt)}.` : null };
      if (c?.kind === "no_show_fee") return { heading, serviceDateNote: days.length ? `Ausfallhonorar für den Termin ${when}.` : null };
      return { heading, serviceDateNote: days.length ? `${range ? "Leistungszeitraum" : "Leistungsdatum"} der stornierten Rechnung: ${plain}` : null };
    }
    case "deposit": {
      const paid = `Anzahlung erhalten am ${dateDe(inv.issuedAt)}`;
      if (!days.length) return { heading: "Quittung über eine Anzahlung", serviceDateNote: `${paid}. Die Leistung wird mit der Rechnung abgerechnet; das Leistungsdatum steht dort.` };
      const future = !!inv.issuedAt && days[0] > inv.issuedAt.slice(0, 10);
      return { heading: "Quittung über eine Anzahlung", serviceDateNote: `${paid} für die Behandlung ${when}${future ? " – Leistung noch nicht erbracht" : ""}.` };
    }
    default:
      return { heading: invoiceTitle(inv), serviceDateNote: days.length ? `Leistungsdatum: ${plain}` : legacyNote };
  }
}

/**
 * Überschrift für Altbelege (vor dem festgeschriebenen Leistungsdatum) – unverändert die frühere Logik, damit ein
 * Neudruck genau so aussieht wie der ausgestellte Beleg. `serviceDates` = Tage der verknüpften Termine/Doku-Einträge.
 */
export function legacyHeading(
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
      return days.length
        ? { heading: `Rechnung zur Behandlung ${days.length > 1 ? `im Zeitraum ${span}` : span}`, serviceDateNote: null }
        : { heading: "Rechnung", serviceDateNote: defaultNote };
    case "receipt":
      return days.length
        ? { heading: `Quittung zur Behandlung ${days.length > 1 ? `im Zeitraum ${span}` : span}`, serviceDateNote: null }
        : { heading: "Quittung", serviceDateNote: defaultNote };
    case "collective":
      if (days.length > 1) return { heading: `Sammelrechnung für den Zeitraum ${span}`, serviceDateNote: null };
      if (days.length === 1) return { heading: `Sammelrechnung zur Behandlung ${span}`, serviceDateNote: null };
      return { heading: "Sammelrechnung", serviceDateNote: defaultNote };
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
