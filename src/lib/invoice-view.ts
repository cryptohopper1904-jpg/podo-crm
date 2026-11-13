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

/**
 * Auf die (Sammel-)Rechnung angerechnete Teilrechnung: Anzahlungs-Quittung (kind = deposit) oder normale, bereits
 * bezahlte Quittung (kind = receipt). `vatGroups` (je Steuersatz) aus den Positionen der Teilrechnung – fehlt es, wird
 * der Satz aus netto/USt zurückgerechnet (eine Anzahlung hat nur einen Satz).
 */
export type CreditedPartial = {
  kind?: "deposit" | "receipt" | string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  netCents?: number | null;
  vatCents?: number | null;
  vatGroups?: { rate: number; netCents: number; vatCents: number }[];
};
/** @deprecated Name aus der Zeit, als nur Anzahlungen angerechnet wurden */
export type CreditedDeposit = CreditedPartial;

const euroDe = (cents: number) => `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** USt-Ausweis einer angerechneten Teilrechnung: „netto … zzgl. 19 % USt …“ (mehrere Sätze mit „+“), leer ohne USt. */
export function creditedTaxText(d: CreditedPartial): string {
  const vat = d.vatCents ?? 0;
  if (!vat) return "";
  const net = d.netCents ?? d.totalCents - vat;
  const groups = (d.vatGroups ?? []).filter((g) => g.vatCents);
  const parts = groups.length
    ? groups.map((g) => `${g.rate} % USt ${euroDe(g.vatCents)}`)
    : [`${net ? Math.round((vat * 100) / net) : 0} % USt ${euroDe(vat)}`];
  return `netto ${euroDe(net)} zzgl. ${parts.join(" + ")}`;
}

/** Text der Abzugszeile je angerechneter Teilrechnung */
export function creditedLabel(d: CreditedPartial, dateDe: (d: string | null) => string): string {
  const tax = creditedTaxText(d);
  const what = d.kind === "receipt" ? `bereits bezahlt mit Quittung ${d.number ?? ""}` : `Anzahlung ${d.number ?? ""}`;
  return `abzgl. ${what} vom ${dateDe(d.issuedAt)}${tax ? ` (${tax})` : ""}`;
}

/**
 * Summenzeilen nach dem Gesamtbetrag: angerechnete Anzahlungen und Quittungen einzeln, danach die übrigen Zahlungen.
 * paidCents enthält die angerechneten Beträge (siehe createInvoice).
 * § 14 Abs. 5 S. 2 UStG: In der Endrechnung werden bei Anzahlungen bzw. Teilrechnungen mit USt auch deren Steuerbeträge
 * abgesetzt – deshalb je Beleg „netto … zzgl. USt …“ und danach die verbleibende USt.
 */
export function paymentSummary(
  inv: { kind: string; paidCents: number; vatCents?: number | null },
  credited: CreditedPartial[],
  dateDe: (d: string | null) => string,
  /** USt je Satz der Rechnung (computeTotals(lines).groups) – dann „verbleibende USt“ je Steuersatz */
  groups?: { rate: number; vatCents: number }[],
) {
  const rows: { label: string; cents: number }[] = credited.map((d) => ({ label: creditedLabel(d, dateDe), cents: -d.totalCents }));
  const creditedCents = credited.reduce((s, d) => s + d.totalCents, 0);
  const creditedVat = credited.reduce((s, d) => s + (d.vatCents ?? 0), 0);
  const perRate = groups && credited.every((d) => !d.vatCents || d.vatGroups);
  if (creditedVat && perRate) {
    const rates = [...new Set([...groups.map((g) => g.rate), ...credited.flatMap((d) => (d.vatGroups ?? []).map((g) => g.rate))])].filter((r) => r > 0).sort((a, b) => a - b);
    for (const rate of rates) {
      const own = groups.find((g) => g.rate === rate)?.vatCents ?? 0;
      const off = credited.reduce((s, d) => s + (d.vatGroups ?? []).filter((g) => g.rate === rate).reduce((x, g) => x + g.vatCents, 0), 0);
      rows.push({ label: `darin verbleibende USt ${rate} %`, cents: own - off });
    }
  } else if (creditedVat && inv.vatCents != null) rows.push({ label: "darin verbleibende USt", cents: inv.vatCents - creditedVat });
  const rest = inv.paidCents - creditedCents;
  if (rest !== 0) rows.push({ label: inv.kind === "credit_note" ? "erstattet/verrechnet" : credited.length ? "weitere Zahlungen" : "bezahlt", cents: rest });
  return rows;
}

/**
 * Hinweis auf der Sammelrechnung mit angerechneten normalen Quittungen (Teilrechnungen → Schlussrechnung).
 * `year`: Leistungsjahr (aus den Leistungsdaten, sonst Rechnungsdatum).
 */
export const creditedReceiptsNote = (year: string | number) =>
  `Diese Rechnung fasst die Leistungen ${year} zusammen. Leistungen, die bereits mit den unten genannten Quittungen abgerechnet und bezahlt wurden, sind nachrichtlich enthalten. Die dort ausgewiesene Umsatzsteuer wird hier abgesetzt und nicht erneut geschuldet. Die Quittungen bleiben gültige Rechnungen.`;

/** Leistungsjahr für den Hinweis: frühestes Leistungsdatum, sonst Rechnungsdatum */
export const serviceYear = (serviceDates: string[], issuedAt: string | null) => ([...serviceDates].sort()[0] ?? issuedAt ?? "").slice(0, 4);

/**
 * Block „Bereits bezahlt (Quittungen)“ auf Sammelrechnung (Druckansicht und PDF): alle angerechneten normalen
 * Quittungen mit Nummer, Datum, Betrag und USt sowie die Summe. Leer, wenn keine Quittung angerechnet ist.
 */
export function creditedReceiptsBlock(credited: CreditedPartial[]) {
  const rows = credited.filter((d) => d.kind === "receipt");
  return {
    rows: rows.map((d) => ({ number: d.number ?? "", issuedAt: d.issuedAt, totalCents: d.totalCents, vatCents: d.vatCents ?? 0 })),
    totalCents: rows.reduce((s, d) => s + d.totalCents, 0),
    vatCents: rows.reduce((s, d) => s + (d.vatCents ?? 0), 0),
  };
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
 * Leistungsdatum für die Buchhaltung (lexoffice shippingDate): Anzahlung → Tag der Zahlung (= Belegdatum); Storno →
 * Leistungsdatum des Originals (Storno einer Anzahlung: deren Belegdatum); sonst letzter Tag des festgeschriebenen
 * Leistungszeitraums. Altbelege ohne festgeschriebene Angabe → Belegdatum (wie bisher).
 */
export function accountingServiceDate(
  inv: { kind: string; issuedAt: string | null; serviceDate?: string | null; serviceDateTo?: string | null; serviceDateFixed?: boolean | null },
  original?: { kind: string; issuedAt: string | null } | null,
): string | null {
  if (inv.kind === "deposit") return inv.issuedAt;
  if (inv.kind === "credit_note" && original?.kind === "deposit") return original.issuedAt;
  if (!inv.serviceDateFixed) return inv.issuedAt;
  return inv.serviceDateTo ?? inv.serviceDate ?? inv.issuedAt;
}

/**
 * Hinweis für die Buchhaltungs-Übergabe: Leistungszeitraum über eine Monatsgrenze mit steuerpflichtigen Anteilen
 * (> 0 % USt) – die Steuer entsteht ggf. je Leistungsmonat. Nur ein Hinweis, die Übergabe läuft trotzdem.
 */
export function monthSpanTaxHint(
  inv: { serviceDate?: string | null; serviceDateTo?: string | null; serviceDateFixed?: boolean | null },
  groups: { rate: number; grossCents: number }[],
): string | null {
  if (!inv.serviceDateFixed || !inv.serviceDate || !inv.serviceDateTo) return null;
  if (inv.serviceDate.slice(0, 7) === inv.serviceDateTo.slice(0, 7)) return null;
  if (!groups.some((g) => g.rate > 0 && g.grossCents !== 0)) return null;
  return "Hinweis: Leistungszeitraum über Monatsgrenze – Steuer ggf. nach Leistungsmonat aufteilen (Steuerberatung).";
}

/** Vorbelegung „Leistungsdatum“/„Leistung bis“ im Rechnungsformular (reine Funktion, siehe invoice-form.tsx) */
export function serviceDateDefaults(o: {
  kind: string;
  issuedAt: string;
  /** vom Nutzer geändert; null = Vorbelegung */
  serviceDate: string | null;
  serviceDateTo: string | null;
  /** Leistungstage der übernommenen Quittungen */
  receiptDays: string[];
  dateDe: (d: string | null) => string;
}): { from: string; to: string; receiptHint: string | null } {
  // eigene Positionen: Rechnungsdatum (Ausfallhonorar: bewusst leer); die Quittungstage ergänzt der Server ohnehin –
  // sie hier vorzubelegen würde den Zeitraum für eigene Positionen (und den Doppel-Hinweis) künstlich verbreitern
  const from = o.serviceDate ?? (o.kind === "no_show_fee" ? "" : o.issuedAt);
  const to = o.serviceDateTo ?? "";
  const days = [...o.receiptDays].sort();
  const span = days.length ? (days[0] === days.at(-1) ? o.dateDe(days[0]) : `${o.dateDe(days[0])}–${o.dateDe(days.at(-1)!)}`) : null;
  return { from, to, receiptHint: span ? `Übernommene Quittungen: ${span} – fließen automatisch in den Leistungszeitraum ein` : null };
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
