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

/** „Zahlbar bis“ und Überweisungshinweis nur bei offenen Rechnungen (nicht bei Quittung/Storno). */
export function showsDueDate(inv: { kind: string; status: string }) {
  return inv.kind !== "receipt" && inv.kind !== "credit_note" && inv.status !== "paid";
}

export const formatIban = (iban: string) => iban.replace(/\s/g, "").replace(/(.{4})/g, "$1 ").trim();

export const qtyDe = (s: string | number) => Number(s).toLocaleString("de-DE", { maximumFractionDigits: 2 });
