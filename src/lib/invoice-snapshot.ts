/**
 * Momentaufnahme der Belegangaben beim Ausstellen (invoices.issued_snapshot) – reine Funktionen ohne Server-Importe.
 *
 * Festgehalten wird alles, was auf dem Beleg steht und sich später in den Stammdaten ändern kann: Praxis (Name,
 * Anschrift, Kontakt, Steuernummer/USt-IdNr., Bankverbindung, Kleinunternehmer-Status, Website, Berufsbezeichnung,
 * WhatsApp-Hinweis), Buchungshinweis sowie Empfänger:in (Patient:in mit Anschrift bzw. Rechnungsempfänger).
 * Druckansicht, Neudruck (z. B. mit Stornovermerk) und PDF lesen diese Angaben statt der aktuellen Stammdaten
 * (§ 14 Abs. 4 UStG, § 147 AO). Nicht enthalten: Logos (Bilddateien; das archivierte PDF enthält sie) und
 * Kontaktwege für den Versand (E-Mail-Adresse der Person bleibt aktuell).
 * Altbelege ohne Momentaufnahme (NULL) zeigen wie bisher die aktuellen Stammdaten.
 */
import type { InvoiceBookingLink } from "./practice-documents";

export const INVOICE_SNAPSHOT_VERSION = 1;

export type SnapshotOrganization = {
  name: string;
  legalName: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  vatId: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  accountHolder: string | null;
  smallBusiness: boolean;
  website: string | null;
  qualification: string | null;
  whatsapp: boolean;
};

export type SnapshotPatient = {
  number: number;
  salutation: string | null;
  title: string | null;
  firstName: string | null;
  lastName: string;
  street: string | null;
  zip: string | null;
  city: string | null;
};

export type SnapshotBillingContact = { name: string; street: string | null; zip: string | null; city: string | null };

export type InvoiceSnapshot = {
  v: number;
  organization: SnapshotOrganization;
  booking: InvoiceBookingLink | null;
  patient: SnapshotPatient | null;
  billingContact: SnapshotBillingContact | null;
};

type OrgInput = Omit<SnapshotOrganization, "website" | "qualification" | "whatsapp" | "bic" | "bankName" | "accountHolder"> & {
  bic?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
};
type PatientInput = { number: number; salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string; street?: string | null; zip?: string | null; city?: string | null };
type ContactInput = { name: string; street?: string | null; zip?: string | null; city?: string | null };

const s = (v: string | null | undefined) => (v === undefined ? null : v);

/** Momentaufnahme aus den aktuellen Stammdaten (beim Ausstellen, in derselben Transaktion). */
export function buildInvoiceSnapshot(input: {
  organization: OrgInput;
  letter: { website: string | null; qualification: string | null; whatsapp: boolean };
  booking: InvoiceBookingLink | null;
  patient: PatientInput | null;
  billingContact: ContactInput | null;
}): InvoiceSnapshot {
  const o = input.organization;
  return {
    v: INVOICE_SNAPSHOT_VERSION,
    organization: {
      name: o.name,
      legalName: s(o.legalName),
      street: s(o.street),
      zip: s(o.zip),
      city: s(o.city),
      phone: s(o.phone),
      email: s(o.email),
      taxNumber: s(o.taxNumber),
      vatId: s(o.vatId),
      iban: s(o.iban),
      bic: s(o.bic),
      bankName: s(o.bankName),
      accountHolder: s(o.accountHolder),
      smallBusiness: !!o.smallBusiness,
      website: input.letter.website ?? null,
      qualification: input.letter.qualification ?? null,
      whatsapp: !!input.letter.whatsapp,
    },
    booking: input.booking ? { label: input.booking.label, url: input.booking.url, display: input.booking.display } : null,
    patient: input.patient
      ? {
          number: input.patient.number,
          salutation: s(input.patient.salutation),
          title: s(input.patient.title),
          firstName: s(input.patient.firstName),
          lastName: input.patient.lastName,
          street: s(input.patient.street),
          zip: s(input.patient.zip),
          city: s(input.patient.city),
        }
      : null,
    billingContact: input.billingContact
      ? { name: input.billingContact.name, street: s(input.billingContact.street), zip: s(input.billingContact.zip), city: s(input.billingContact.city) }
      : null,
  };
}

/** Liest die gespeicherte Momentaufnahme (null = Altbeleg oder unbekanntes Format → aktuelle Stammdaten). */
export function readInvoiceSnapshot(raw: unknown): InvoiceSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<InvoiceSnapshot>;
  if (r.v !== INVOICE_SNAPSHOT_VERSION || !r.organization || typeof r.organization.name !== "string") return null;
  return {
    v: r.v,
    organization: r.organization,
    booking: r.booking ?? null,
    patient: r.patient ?? null,
    billingContact: r.billingContact ?? null,
  };
}

/**
 * Belegangaben für Druckansicht/PDF: aus der Momentaufnahme, sonst live. Die übrigen Felder (IDs, Einstellungen,
 * E-Mail/Telefon der Person für den Versand) bleiben aus den aktuellen Datensätzen erhalten.
 */
export function withSnapshot<
  O extends Record<string, unknown>,
  P extends Record<string, unknown> | null,
  B extends Record<string, unknown> | null,
>(
  snap: InvoiceSnapshot | null,
  live: { organization: O; patient: P; billingContact: B; letter: { website: string | null; qualification: string | null; whatsapp: boolean }; booking: InvoiceBookingLink | null },
) {
  if (!snap) return { ...live, fromSnapshot: false as const };
  const { website, qualification, whatsapp, ...org } = snap.organization;
  return {
    organization: { ...live.organization, ...org } as O & SnapshotOrganization,
    // Person/Empfänger wie beim Ausstellen; gab es sie damals nicht (oder ist sie nicht mehr lesbar), bleibt es dabei
    patient: (snap.patient ? { ...(live.patient ?? {}), ...snap.patient } : live.patient) as P,
    billingContact: (snap.billingContact ? { ...(live.billingContact ?? {}), ...snap.billingContact } : null) as B,
    letter: { website, qualification, whatsapp },
    booking: snap.booking,
    fromSnapshot: true as const,
  };
}

/** Ende der Aufbewahrungsfrist eines Belegs: 31.12. des 10. Jahres nach dem Ausstellungsjahr (§ 147 Abs. 3, 4 AO, § 14b UStG). */
export function retainUntilFor(issuedAt: string | Date): string {
  const year = typeof issuedAt === "string" ? Number(issuedAt.slice(0, 4)) : issuedAt.getUTCFullYear();
  return `${year + 10}-12-31`;
}
