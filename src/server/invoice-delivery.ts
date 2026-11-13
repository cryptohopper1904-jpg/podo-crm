import "server-only";
import { and, asc, eq, gte, inArray, lt, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { appointmentServices, billingContacts, invoiceLines, invoices, messages, patients, services, treatmentRecords } from "@/db/schema";
import { MailNotConfiguredError, MailSendError } from "@/integrations/mail/mail";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, berlinToUtc, dateDe, money } from "@/lib/format";
import { INVOICE_KIND_LABEL } from "@/lib/invoice-labels";
import { invoicePdfFilename, renderInvoicePdf, type InvoicePdfData } from "@/lib/invoice-pdf";
import { dueImmediately, showsDueDate } from "@/lib/invoice-view";
import { invoiceBookingLink, practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { loadLogos } from "./practice-logos";
import { logSync } from "./integrations";
import { mailMessagingPort } from "./mail";
import { InvoiceError, loadInvoiceBundle, type InvoiceBundle } from "./invoices";

/**
 * PDF einer Rechnung für einen Mandanten. Mit `patientId` (Patientenportal) wird zusätzlich geprüft,
 * dass die Rechnung genau dieser Person gehört. Entwürfe werden nie ausgeliefert.
 */
export async function invoicePdfForOrg(org: string, invoiceId: string, opts: { patientId?: string } = {}) {
  if (!z.uuid().safeParse(invoiceId).success) return null;
  const bundle = await withOrg(org, (tx) => loadInvoiceBundle(tx, org, invoiceId));
  if (!bundle || bundle.invoice.status === "draft") return null;
  if (opts.patientId !== undefined && bundle.invoice.patientId !== opts.patientId) return null;
  const bytes = await renderInvoicePdf(await invoicePdfData(bundle));
  return { bytes, filename: invoicePdfFilename(bundle.invoice), bundle };
}

/**
 * Belegdaten + Praxis-Angaben für das PDF: Logos, Website, Berufsbezeichnung, WhatsApp-Hinweis und
 * Buchungshinweis (Einstellungen → Praxisdaten → Belege). Fehlt etwas, sieht der Beleg aus wie ohne.
 */
export async function invoicePdfData(bundle: InvoiceBundle): Promise<InvoicePdfData> {
  const o = bundle.organization;
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const doc = readDocumentSettings(settings);
  const logos = await loadLogos(o.id);
  return {
    ...bundle,
    organization: { ...o, website: practiceWebsite(settings), qualification: doc.qualification, whatsapp: doc.whatsapp },
    logos,
    booking: invoiceBookingLink(settings, { slug: o.slug, publicUrl: process.env.PUBLIC_URL }),
  };
}

export function pdfResponseHeaders(filename: string, disposition: "inline" | "attachment" = "inline") {
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Text der Begleit-E-Mail – nur Belegdaten, keine Leistungen/Diagnosen. */
export function invoiceEmailText(b: Pick<InvoiceBundle, "invoice" | "organization"> & { recipientName?: string | null }) {
  const inv = b.invoice;
  const o = b.organization;
  const label = inv.kind === "credit_note" ? "Stornorechnung" : INVOICE_KIND_LABEL[inv.kind] ?? "Rechnung";
  const open = inv.totalCents - inv.paidCents;
  const lines = [
    "Guten Tag,",
    "",
    `anbei erhalten Sie Ihre ${label} ${inv.number} vom ${dateDe(inv.issuedAt)} über ${money(inv.totalCents)} als PDF.`,
  ];
  if (showsDueDate(inv) && open > 0) {
    const when = dueImmediately(inv) ? "sofort" : `bis zum ${dateDe(inv.dueAt)}`;
    lines.push(`Bitte überweisen Sie den offenen Betrag von ${money(open)} ${when} unter Angabe der Rechnungsnummer.`);
    if (inv.paymentLinkUrl) lines.push(`Alternativ können Sie bequem online bezahlen: ${inv.paymentLinkUrl}`);
  }
  lines.push("", "Bei Fragen erreichen Sie uns gern" + (o.phone ? ` unter ${o.phone}` : "") + ".", "", "Mit freundlichen Grüßen", o.legalName ?? o.name);
  return { subject: `${label} ${inv.number} – ${o.name}`, body: lines.join("\n") };
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Rechnung per E-Mail (MessagingPort email_imap) mit PDF-Anhang an den Rechnungsempfänger bzw. die Person senden. */
export async function sendInvoiceEmail(auth: AuthContext, invoiceId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const pdf = await invoicePdfForOrg(org, invoiceId);
  if (!pdf) throw new InvoiceError("Rechnung nicht gefunden oder nicht ausgestellt.");
  const { bundle } = pdf;
  const to = (bundle.billingContact?.email || bundle.patient?.email || "").trim();
  if (!to) throw new InvoiceError("Keine E-Mail-Adresse beim Rechnungsempfänger bzw. in der Patientenakte hinterlegt.");
  if (!EMAIL_RE.test(to)) throw new InvoiceError("Die hinterlegte E-Mail-Adresse ist ungültig.");
  const { subject, body } = invoiceEmailText(bundle);

  let externalId: string;
  let mock = false;
  try {
    // MailPort (SMTP der Praxis / Plattform-SMTP / Testmodus) – Drosselung und Fehler-Audit in ./mail
    const port = await mailMessagingPort(org, { purpose: "invoice", userId: auth.user.id, entity: "invoice", entityId: invoiceId });
    mock = port.isMock;
    externalId = (await port.send({ to, subject, body, attachments: [{ filename: pdf.filename, contentType: "application/pdf", data: pdf.bytes }] })).externalId;
  } catch (e) {
    await logSync(org, "email_imap", { direction: "out", ok: false, message: `Rechnung ${bundle.invoice.number}: ${describeError(e)}`, entity: "invoice", entityId: invoiceId });
    // sichere Meldung (ohne Zugangsdaten) direkt anzeigen
    throw new InvoiceError(`E-Mail-Versand fehlgeschlagen: ${e instanceof MailSendError || e instanceof MailNotConfiguredError ? e.message : "Details im Synchronisationsprotokoll."}`);
  }
  await withOrg(org, async (tx) => {
    // sent_at/sent_to sind nicht durch den GoBD-Trigger gesperrt
    await tx.update(invoices).set({ sentAt: new Date(), sentTo: to }).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: bundle.invoice.patientId,
      channel: "email",
      direction: "outbound",
      toAddress: to,
      subject,
      body: `${body}\n\n[Anhang: ${pdf.filename}]`,
      status: "answered",
      externalId,
      threadKey: to,
    });
  });
  await logSync(org, "email_imap", { direction: "out", ok: true, message: `Rechnung ${bundle.invoice.number}: ${mock ? "Testmodus – nicht wirklich versendet" : "versendet"}`, entity: "invoice", entityId: invoiceId });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.send_email", entity: "invoice", entityId: invoiceId, meta: { mock } });
  return { to, mock };
}

// ───────────── Sammelrechnung Pflegeheim ─────────────

export type CollectiveSuggestionLine = { treatmentRecordId: string; serviceId: string | null; description: string; quantity: number; unitPriceCents: number | null; vatRate: number };

function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: berlinToUtc(`${month}-01`, "00:00"), to: berlinToUtc(next, "00:00") };
}

/** date-Spalte (YYYY-MM-DD) oder Zeitpunkt → Kalendertag in Berlin */
const isoDay = (d: string | Date) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : berlinDateIso(new Date(d)));

/** Kennung einer Vorschlagszeile: „Nachname, Vorname, TT.MM.JJJJ“ – dient auch der Doppelt-Erkennung. */
export const collectiveLineKey = (p: { lastName: string; firstName: string | null }, day: Date) =>
  `${[p.lastName, p.firstName].filter(Boolean).join(", ")}, ${dateDe(day)}`;

/**
 * Vorschlag für eine Sammelrechnung an ein Pflegeheim: je Behandlung (Doku-Eintrag) der Bewohner:innen
 * (patients.care_home_id = Pflegeheim) im gewählten Monat eine Position – mit den Leistungen des
 * verknüpften Termins (Katalogpreis), sonst als Freitext ohne Preis.
 *
 * „Noch nicht abgerechnet“: übersprungen wird ein Eintrag, wenn
 *  - eine nicht stornierte Rechnung bereits eine Position mit diesem Doku-Eintrag (treatment_record_id) hat, oder
 *  - (Altbestand ohne Bezug) für die Person am selben Tag bereits eine eigene Rechnung ausgestellt wurde.
 * createInvoice prüft die Doppelabrechnung zusätzlich verbindlich.
 * Es werden nur Datum/Termin der Doku gelesen, keine medizinischen Inhalte.
 */
export async function collectiveSuggestion(auth: AuthContext, billingContactId: string, month: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(billingContactId).success) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) month = berlinDateIso().slice(0, 7);
  const { from, to } = monthRange(month);
  const result = await withOrg(org, async (tx) => {
    const [contact] = await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, billingContactId)));
    if (!contact) return null;
    const residents = await tx
      .select({ id: patients.id, firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.careHomeId, billingContactId)));
    if (!residents.length) return { contact, lines: [] as CollectiveSuggestionLine[], skipped: 0, records: 0 };
    const byId = new Map(residents.map((r) => [r.id, r]));
    const recs = await tx
      .select({ id: treatmentRecords.id, patientId: treatmentRecords.patientId, treatedAt: treatmentRecords.treatedAt, appointmentId: treatmentRecords.appointmentId })
      .from(treatmentRecords)
      .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.patientId, [...byId.keys()]), gte(treatmentRecords.treatedAt, from), lt(treatmentRecords.treatedAt, to)))
      .orderBy(asc(treatmentRecords.treatedAt));
    const apptIds = [...new Set(recs.map((r) => r.appointmentId).filter((x): x is string => !!x))];
    const svcRows = apptIds.length
      ? await tx
          .select({ appointmentId: appointmentServices.appointmentId, quantity: appointmentServices.quantity, serviceId: services.id, name: services.name, priceCents: services.priceCents, vatRate: services.vatRate })
          .from(appointmentServices)
          .innerJoin(services, eq(services.id, appointmentServices.serviceId))
          .where(and(eq(appointmentServices.organizationId, org), inArray(appointmentServices.appointmentId, apptIds)))
      : [];
    // bereits abgerechnet? → exakt über invoice_lines.treatment_record_id (nicht stornierte Rechnungen)
    const recIds = recs.map((r) => r.id);
    const billedRows = recIds.length
      ? await tx
          .select({ recordId: invoiceLines.treatmentRecordId })
          .from(invoiceLines)
          .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
          .where(and(eq(invoiceLines.organizationId, org), inArray(invoiceLines.treatmentRecordId, recIds), notInArray(invoices.status, ["cancelled", "draft"]), ne(invoices.kind, "deposit")))
      : [];
    const billed = new Set(billedRows.map((b) => b.recordId));
    // Zusatz-Heuristik für Altbestand ohne Behandlungsbezug: eigene Rechnung der Person am Behandlungstag
    const own = await tx
      .select({ patientId: invoices.patientId, issuedAt: invoices.issuedAt })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), inArray(invoices.patientId, [...byId.keys()]), notInArray(invoices.status, ["cancelled", "draft"]), notInArray(invoices.kind, ["credit_note", "collective", "deposit"])));
    const ownKeys = new Set(own.filter((o) => o.issuedAt).map((o) => `${o.patientId}|${isoDay(o.issuedAt!)}`));

    const lines: CollectiveSuggestionLine[] = [];
    let skipped = 0;
    for (const r of recs) {
      const p = byId.get(r.patientId)!;
      if (billed.has(r.id) || ownKeys.has(`${r.patientId}|${berlinDateIso(r.treatedAt)}`)) {
        skipped++;
        continue;
      }
      const key = collectiveLineKey(p, r.treatedAt);
      const svc = r.appointmentId ? svcRows.filter((x) => x.appointmentId === r.appointmentId) : [];
      if (svc.length) {
        for (const x of svc) lines.push({ treatmentRecordId: r.id, serviceId: x.serviceId, description: `${key}: ${x.name}`, quantity: Number(x.quantity) || 1, unitPriceCents: x.priceCents, vatRate: x.vatRate });
      } else {
        lines.push({ treatmentRecordId: r.id, serviceId: null, description: `${key}: Behandlung`, quantity: 1, unitPriceCents: null, vatRate: 0 });
      }
    }
    return { contact, lines, skipped, records: recs.length };
  });
  if (result) await audit({ organizationId: org, userId: auth.user.id, action: "invoice.collective_suggest", entity: "billing_contact", entityId: billingContactId, meta: { month, lines: result.lines.length, skipped: result.skipped } });
  return result ? { ...result, month, contact: { id: result.contact.id, name: result.contact.name, kind: result.contact.kind } } : null;
}

export async function careHomes(auth: AuthContext) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ id: billingContacts.id, name: billingContacts.name })
      .from(billingContacts)
      .where(and(eq(billingContacts.organizationId, org), eq(billingContacts.kind, "care_home")))
      .orderBy(asc(billingContacts.name)),
  );
}
