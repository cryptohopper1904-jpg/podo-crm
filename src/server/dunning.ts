import "server-only";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { billingContacts, invoiceDunnings, invoices, messages, organizations, patients } from "@/db/schema";
import { MailNotConfiguredError, MailSendError } from "@/integrations/mail/mail";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import {
  DUNNABLE_KINDS,
  DUNNABLE_STATUSES,
  DUNNING_STAGE_LABEL,
  DUNNING_STAGES,
  MAX_FEE_CENTS,
  MAX_PAY_DAYS,
  MAX_STAGE_DAYS,
  MAX_TEXT,
  dunningState,
  dunningTotalCents,
  fillTemplate,
  readDunningSettings,
  salutationLine,
  type DunningStage,
  type DunningState,
} from "@/lib/dunning";
import { dunningPdfFilename, renderDunningPdf, type DunningPdfData } from "@/lib/dunning-pdf";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { addDaysIso } from "@/lib/invoice-math";
import { practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { logSync } from "./integrations";
import { mailMessagingPort } from "./mail";
import { InvoiceError } from "./invoices";
import { loadLogos } from "./practice-logos";

export type DunningRow = typeof invoiceDunnings.$inferSelect;

const nameOf = (r: { patientFirst: string | null; patientLast: string | null; billingName: string | null }) =>
  r.billingName
    ? `${r.billingName}${r.patientLast ? ` (${[r.patientFirst, r.patientLast].filter(Boolean).join(" ")})` : ""}`
    : [r.patientFirst, r.patientLast].filter(Boolean).join(" ") || "–";

async function orgSettings(tx: Tx, org: string) {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  return (o?.settings ?? {}) as Record<string, unknown>;
}

export type DunningOverviewRow = {
  invoiceId: string;
  number: string | null;
  kind: string;
  name: string;
  issuedAt: string | null;
  dueAt: string | null;
  totalCents: number;
  openCents: number;
  hasEmail: boolean;
  state: DunningState;
  last: { id: string; stage: DunningStage; letterDate: string; sentVia: string | null } | null;
};

/**
 * Überfällige Rechnungen (Zahlungsziel überschritten, ausgestellt, noch offen; nur Rechnung/Sammelrechnung/
 * Ausfallhonorar – nie Quittungen, Anzahlungen oder Stornos) mit nächster Mahnstufe.
 */
export async function dunningOverview(auth: AuthContext) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  const today = berlinDateIso();
  return withOrg(org, async (tx) => {
    const settings = readDunningSettings(await orgSettings(tx, org));
    const rows = await tx
      .select({
        invoice: invoices,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        patientEmail: patients.email,
        billingName: billingContacts.name,
        billingEmail: billingContacts.email,
      })
      .from(invoices)
      .leftJoin(patients, eq(patients.id, invoices.patientId))
      .leftJoin(billingContacts, eq(billingContacts.id, invoices.billingContactId))
      .where(
        and(
          eq(invoices.organizationId, org),
          inArray(invoices.kind, [...DUNNABLE_KINDS]),
          inArray(invoices.status, [...DUNNABLE_STATUSES]),
          lt(invoices.dueAt, today),
          sql`${invoices.totalCents} > ${invoices.paidCents}`,
        ),
      )
      .orderBy(asc(invoices.dueAt), asc(invoices.number));
    const ids = rows.map((r) => r.invoice.id);
    const past = ids.length
      ? await tx
          .select()
          .from(invoiceDunnings)
          .where(and(eq(invoiceDunnings.organizationId, org), inArray(invoiceDunnings.invoiceId, ids)))
          .orderBy(asc(invoiceDunnings.createdAt))
      : [];
    const list: DunningOverviewRow[] = rows.map((r) => {
      const inv = r.invoice;
      const mine = past.filter((p) => p.invoiceId === inv.id);
      const lastRow = mine.at(-1) ?? null;
      return {
        invoiceId: inv.id,
        number: inv.number,
        kind: inv.kind,
        name: nameOf(r),
        issuedAt: inv.issuedAt,
        dueAt: inv.dueAt,
        totalCents: inv.totalCents,
        openCents: inv.totalCents - inv.paidCents,
        hasEmail: !!(r.billingEmail || r.patientEmail)?.trim(),
        state: dunningState(inv, mine, settings, today),
        last: lastRow ? { id: lastRow.id, stage: lastRow.stage as DunningStage, letterDate: lastRow.letterDate, sentVia: lastRow.sentVia } : null,
      };
    });
    return { rows: list, settings, today };
  });
}

/** Mahnungen einer Rechnung (älteste zuerst) – für die Detailseite. */
export async function invoiceDunningList(auth: AuthContext, invoiceId: string) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(invoiceId).success) return [];
  return withOrg(org, (tx) =>
    tx
      .select()
      .from(invoiceDunnings)
      .where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.invoiceId, invoiceId)))
      .orderBy(asc(invoiceDunnings.createdAt)),
  );
}

export type CreateDunningsResult = {
  created: { invoiceId: string; dunningId: string; number: string | null; stage: DunningStage }[];
  skipped: { invoiceId: string; number: string | null; reason: string }[];
};

/**
 * Erstellt für jede gewählte Rechnung die jetzt fällige nächste Mahnstufe (unveränderbar gespeichert).
 * Rechnungen ohne fällige Stufe (bezahlt, storniert, Quittung, noch nicht dran, alle Stufen erledigt) werden übersprungen.
 * Jede Rechnung in einer eigenen Transaktion (mit Zeilensperre) – ein Fehler hält die anderen nicht auf.
 */
export async function createDunnings(auth: AuthContext, invoiceIds: string[]): Promise<CreateDunningsResult> {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const ids = [...new Set(invoiceIds)].filter((id) => z.uuid().safeParse(id).success).slice(0, 200);
  if (!ids.length) throw new InvoiceError("Bitte mindestens eine Rechnung auswählen.");
  const today = berlinDateIso();
  const result: CreateDunningsResult = { created: [], skipped: [] };
  for (const invoiceId of ids) {
    try {
      type Outcome = { created: string; stage: DunningStage; number: string | null } | { skip: string; number: string | null };
      const r = await withOrg(org, async (tx): Promise<Outcome> => {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)))
          .for("update");
        if (!inv) return { skip: "Rechnung nicht gefunden.", number: null };
        const past = await tx
          .select()
          .from(invoiceDunnings)
          .where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.invoiceId, invoiceId)));
        const settings = readDunningSettings(await orgSettings(tx, org));
        const st = dunningState(inv, past, settings, today);
        if (st.state === "not_dunnable") return { skip: st.reason, number: inv.number };
        if (st.state === "not_overdue") return { skip: "Noch nicht überfällig.", number: inv.number };
        if (st.state === "exhausted") return { skip: "Alle Mahnstufen sind bereits erstellt.", number: inv.number };
        if (st.state === "waiting") return { skip: `${DUNNING_STAGE_LABEL[st.next]} ist erst ab ${dateDe(st.dueOn)} fällig.`, number: inv.number };
        const stage = st.next;
        const patient = inv.patientId
          ? await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))).then((x) => x[0] ?? null)
          : null;
        const billing = inv.billingContactId
          ? await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))).then((x) => x[0] ?? null)
          : null;
        const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
        const openCents = inv.totalCents - inv.paidCents;
        const feeCents = settings.stages[stage].feeCents;
        const feesTotalCents = past.reduce((s, p) => s + p.feeCents, 0) + feeCents;
        const payBy = addDaysIso(today, settings.payDays);
        const body = fillTemplate(settings.stages[stage].text, {
          anrede: salutationLine(patient, billing?.name),
          rechnungsnummer: inv.number ?? "",
          rechnungsdatum: dateDe(inv.issuedAt),
          faellig_am: dateDe(inv.dueAt),
          offener_betrag: money(openCents),
          gebuehren: money(feesTotalCents),
          gesamtbetrag: money(dunningTotalCents(openCents, feesTotalCents)),
          frist: dateDe(payBy),
          praxis: o?.legalName ?? o?.name ?? "",
        }).slice(0, MAX_TEXT * 2);
        const [row] = await tx
          .insert(invoiceDunnings)
          .values({ organizationId: org, invoiceId, stage, letterDate: today, payBy, openCents, feeCents, feesTotalCents, body, letterhead: letterheadSnapshot(o, patient, billing), createdBy: auth.user.id })
          .returning({ id: invoiceDunnings.id });
        await audit(
          { organizationId: org, userId: auth.user.id, action: "invoice.dunning_create", entity: "invoice", entityId: invoiceId, meta: { dunningId: row.id, stage, openCents, feeCents, feesTotalCents } },
          tx,
        );
        return { created: row.id, stage, number: inv.number };
      });
      if ("created" in r) result.created.push({ invoiceId, dunningId: r.created, number: r.number, stage: r.stage });
      else result.skipped.push({ invoiceId, number: r.number, reason: r.skip });
    } catch (e) {
      // zeitgleich erstellt (eindeutiger Index) oder DB-Schutzregel → übersprungen, nicht abgebrochen
      const msg = e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      if (cause?.code === "23505" || /invoice_dunnings_invoice_stage/.test(msg)) result.skipped.push({ invoiceId, number: null, reason: "Diese Mahnstufe wurde gerade bereits erstellt." });
      else if (cause?.code === "P0001") result.skipped.push({ invoiceId, number: null, reason: cause.message ?? "Nicht zulässig." });
      else throw e;
    }
  }
  return result;
}

type OrgRow = typeof organizations.$inferSelect;
type PatientRow = typeof patients.$inferSelect;
type BillingRow = typeof billingContacts.$inferSelect;
export type DunningLetterhead = Pick<DunningPdfData, "organization" | "patient" | "billingContact">;

/**
 * Briefkopf, Bankverbindung und Empfängeranschrift beim Erstellen einfrieren – ein späterer Nachdruck
 * entspricht so dem versendeten Schreiben (§ 147 AO), auch wenn sich Praxis- oder Patientendaten ändern.
 */
export function letterheadSnapshot(o: OrgRow, patient: PatientRow | null, billing: BillingRow | null): DunningLetterhead {
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const doc = readDocumentSettings(settings);
  return {
    organization: {
      name: o.name,
      legalName: o.legalName,
      street: o.street,
      zip: o.zip,
      city: o.city,
      phone: o.phone,
      email: o.email,
      taxNumber: o.taxNumber,
      vatId: o.vatId,
      iban: o.iban,
      bic: o.bic,
      bankName: o.bankName,
      accountHolder: o.accountHolder,
      smallBusiness: o.smallBusiness,
      website: practiceWebsite(settings),
      qualification: doc.qualification,
      whatsapp: doc.whatsapp,
    },
    patient: patient
      ? { number: patient.number, salutation: patient.salutation, title: patient.title, firstName: patient.firstName, lastName: patient.lastName, street: patient.street, zip: patient.zip, city: patient.city }
      : null,
    billingContact: billing ? { name: billing.name, street: billing.street, zip: billing.zip, city: billing.city } : null,
  };
}

/** Mahnung + Rechnung + Praxisangaben für das PDF (innerhalb von withOrg). */
async function loadDunning(tx: Tx, org: string, dunningId: string) {
  const [d] = await tx.select().from(invoiceDunnings).where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.id, dunningId)));
  if (!d) return null;
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, d.invoiceId)));
  if (!inv) return null;
  const earlier = await tx
    .select({ stage: invoiceDunnings.stage, feeCents: invoiceDunnings.feeCents, createdAt: invoiceDunnings.createdAt })
    .from(invoiceDunnings)
    .where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.invoiceId, d.invoiceId)));
  const order = (s: string) => DUNNING_STAGES.indexOf(s as DunningStage);
  const fees = earlier.filter((x) => order(x.stage) <= order(d.stage)).sort((a, b) => order(a.stage) - order(b.stage)).map((x) => ({ stage: x.stage as DunningStage, feeCents: x.feeCents }));
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  const patient = inv.patientId ? await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))).then((r) => r[0] ?? null) : null;
  const billing = inv.billingContactId
    ? await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))).then((r) => r[0] ?? null)
    : null;
  return { dunning: d, fees, invoice: inv, organization: o, patient, billingContact: billing };
}

export async function dunningPdfForOrg(org: string, dunningId: string) {
  if (!z.uuid().safeParse(dunningId).success) return null;
  const b = await withOrg(org, (tx) => loadDunning(tx, org, dunningId));
  if (!b) return null;
  const snap = b.dunning.letterhead as unknown as DunningLetterhead;
  const data: DunningPdfData = {
    dunning: { ...b.dunning, stage: b.dunning.stage as DunningStage, fees: b.fees },
    invoice: b.invoice,
    organization: snap.organization,
    patient: snap.patient,
    billingContact: snap.billingContact,
    logos: await loadLogos(org),
  };
  const bytes = await renderDunningPdf(data);
  return { bytes, filename: dunningPdfFilename({ stage: data.dunning.stage }, b.invoice), bundle: b };
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Begleit-E-Mail: Text des Schreibens, Anhang PDF. */
export function dunningEmailText(b: { dunning: Pick<DunningRow, "stage" | "body">; invoice: { number: string | null }; organization: { name: string; legalName: string | null; phone: string | null } }) {
  const label = DUNNING_STAGE_LABEL[b.dunning.stage as DunningStage] ?? "Mahnung";
  const o = b.organization;
  const body = [b.dunning.body, "", "Das Schreiben finden Sie zusätzlich als PDF im Anhang.", "", "Bei Fragen erreichen Sie uns gern" + (o.phone ? ` unter ${o.phone}` : "") + ".", "", "Mit freundlichen Grüßen", o.legalName ?? o.name].join("\n");
  return { subject: `${label} zur Rechnung ${b.invoice.number ?? ""} – ${o.name}`, body };
}

/** Mahnung per E-Mail (PDF-Anhang) an Rechnungsempfänger bzw. Person. Nicht mehr, wenn die Rechnung inzwischen bezahlt/storniert ist. */
export async function sendDunningEmail(auth: AuthContext, dunningId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const pdf = await dunningPdfForOrg(org, dunningId);
  if (!pdf) throw new InvoiceError("Mahnung nicht gefunden.");
  const { bundle } = pdf;
  const inv = bundle.invoice;
  if (inv.status !== "issued" && inv.status !== "partially_paid") throw new InvoiceError("Die Rechnung ist inzwischen bezahlt oder storniert – die Mahnung wird nicht mehr versendet.");
  if (bundle.dunning.sentVia) throw new InvoiceError("Dieses Schreiben ist bereits als versendet vermerkt.");
  const to = (bundle.billingContact?.email || bundle.patient?.email || "").trim();
  if (!to) throw new InvoiceError("Keine E-Mail-Adresse beim Rechnungsempfänger bzw. in der Patientenakte hinterlegt.");
  if (!EMAIL_RE.test(to)) throw new InvoiceError("Die hinterlegte E-Mail-Adresse ist ungültig.");
  const { subject, body } = dunningEmailText(bundle);
  let externalId: string;
  let mock = false;
  try {
    const port = await mailMessagingPort(org, { purpose: "dunning", userId: auth.user.id, entity: "invoice", entityId: inv.id });
    mock = port.isMock;
    externalId = (await port.send({ to, subject, body, attachments: [{ filename: pdf.filename, contentType: "application/pdf", data: pdf.bytes }] })).externalId;
  } catch (e) {
    await logSync(org, "email_imap", { direction: "out", ok: false, message: `Mahnung ${inv.number}: ${describeError(e)}`, entity: "invoice", entityId: inv.id });
    throw new InvoiceError(`E-Mail-Versand fehlgeschlagen: ${e instanceof MailSendError || e instanceof MailNotConfiguredError ? e.message : "Details im Synchronisationsprotokoll."}`);
  }
  await withOrg(org, async (tx) => {
    await tx
      .update(invoiceDunnings)
      .set({ sentVia: "email", sentAt: new Date(), sentTo: to })
      .where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.id, dunningId), isNull(invoiceDunnings.sentVia)));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: inv.patientId,
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
  await logSync(org, "email_imap", { direction: "out", ok: true, message: `Mahnung ${inv.number}: ${mock ? "Testmodus – nicht wirklich versendet" : "versendet"}`, entity: "invoice", entityId: inv.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.dunning_send_email", entity: "invoice", entityId: inv.id, meta: { dunningId, stage: bundle.dunning.stage, mock } });
  return { to, mock, invoiceId: inv.id };
}

/** Versandvermerk „per Post“ (Ausdruck verschickt). */
export async function markDunningPosted(auth: AuthContext, dunningId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(dunningId).success) throw new InvoiceError("Mahnung nicht gefunden.");
  const row = await withOrg(org, async (tx) => {
    const [d] = await tx
      .update(invoiceDunnings)
      .set({ sentVia: "post", sentAt: new Date(), sentTo: null })
      .where(and(eq(invoiceDunnings.organizationId, org), eq(invoiceDunnings.id, dunningId), isNull(invoiceDunnings.sentVia)))
      .returning({ invoiceId: invoiceDunnings.invoiceId, stage: invoiceDunnings.stage });
    return d ?? null;
  });
  if (!row) throw new InvoiceError("Mahnung nicht gefunden oder bereits als versendet vermerkt.");
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.dunning_mark_posted", entity: "invoice", entityId: row.invoiceId, meta: { dunningId, stage: row.stage } });
  return row;
}

// ───────────── Einstellungen ─────────────

const stageInput = z.object({
  days: z.coerce.number({ error: "Tage: bitte eine Zahl angeben." }).int("Tage: ganze Zahl").min(1, "Tage: mindestens 1").max(MAX_STAGE_DAYS, `Tage: höchstens ${MAX_STAGE_DAYS}`),
  feeCents: z
    .number()
    .int()
    .min(0, "Gebühr: nicht negativ")
    .max(MAX_FEE_CENTS, MAX_FEE_CENTS > 0 ? `Gebühr: höchstens ${money(MAX_FEE_CENTS)} (nur konkrete Kosten)` : "Mahngebühren folgen, sobald die Verbuchung eingebaut ist."),
  text: z.string().trim().min(20, "Text: bitte einen Brieftext angeben.").max(MAX_TEXT, `Text: höchstens ${MAX_TEXT} Zeichen`),
});
export const dunningSettingsInput = z.object({
  payDays: z.coerce.number({ error: "Zahlungsfrist: bitte eine Zahl angeben." }).int().min(1, "Zahlungsfrist: mindestens 1 Tag").max(MAX_PAY_DAYS, `Zahlungsfrist: höchstens ${MAX_PAY_DAYS} Tage`),
  stages: z.object({ reminder: stageInput, dunning1: stageInput, dunning2: stageInput }),
});
export type DunningSettingsInput = z.infer<typeof dunningSettingsInput>;

export async function saveDunningSettings(auth: AuthContext, input: DunningSettingsInput) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  // Zahlungserinnerung begründet erst den Verzug (§ 286 Abs. 1 BGB) → keine Gebühr;
  // übrige Stufen höchstens MAX_FEE_CENTS (vorerst 0 €, bis Gebühren verbucht werden können)
  const cap = (fee: number) => Math.min(Math.max(0, fee), MAX_FEE_CENTS);
  const value = {
    ...input,
    stages: {
      reminder: { ...input.stages.reminder, feeCents: 0 },
      dunning1: { ...input.stages.dunning1, feeCents: cap(input.stages.dunning1.feeCents) },
      dunning2: { ...input.stages.dunning2, feeCents: cap(input.stages.dunning2.feeCents) },
    },
  };
  await withOrg(org, (tx) =>
    tx
      .update(organizations)
      .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('dunning', ${JSON.stringify(value)}::jsonb)` })
      .where(eq(organizations.id, org)),
  );
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "settings.dunning",
    meta: { payDays: value.payDays, days: DUNNING_STAGES.map((s) => value.stages[s].days), feeCents: DUNNING_STAGES.map((s) => value.stages[s].feeCents) },
  });
  return value;
}
