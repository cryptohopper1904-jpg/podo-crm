import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MAX_DUE_DAYS, readDocumentSettings } from "@/lib/practice-documents";
import { withOrg, type Tx } from "@/db";
import {
  appointments,
  billingContacts,
  integrationConnections,
  invoiceLines,
  invoices,
  organizations,
  patients,
  payments,
  services,
  syncLog,
  treatmentRecords,
  vouchers,
} from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import { getAdapter } from "@/integrations/registry";
import { fiscalRef } from "@/integrations/tse";
import { FiscalSignError, needsSignature, signRegisterPayment, storeSignature, type SignedPayment } from "./fiscal";
import { berlinDateIso, dateDe } from "@/lib/format";
import { nextNumber } from "@/lib/numbering";
import {
  addDaysIso,
  computeTotals,
  creditNoteSettlement,
  effectiveVatRate,
  isVatRate,
  lineTotalCents,
  needsTherapeuticConfirmation,
  negateLines,
  statusFromPayments,
  validatePayments,
  voucherBalance,
} from "@/lib/invoice-math";
import { CREATABLE_KINDS, DEPOSIT_METHODS, INTERNAL_NOTE_PREFIX, PAYMENT_METHODS, THERAPEUTIC_LABEL } from "@/lib/invoice-labels";

export class InvoiceError extends Error {}

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optUuid = z.preprocess(emptyToNull, z.uuid().nullable().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");

export const lineInput = z.object({
  serviceId: optUuid,
  /** Sammelrechnung: abgerechnete Behandlung (Doku-Eintrag) – verhindert Doppelabrechnung */
  treatmentRecordId: optUuid,
  /** Rechnung aus dem Termin: abgerechneter Termin – verhindert Doppelabrechnung */
  appointmentId: optUuid,
  description: z.string().trim().max(300).default(""),
  quantity: z.coerce.number().positive("Menge muss größer 0 sein").max(9999),
  factor: z.coerce.number().positive("Faktor muss größer 0 sein").max(99),
  unitPriceCents: z.coerce.number().int().min(0, "Preis darf nicht negativ sein").max(10_000_000),
  vatRate: z.coerce.number().int(),
});
export type LineInput = z.infer<typeof lineInput>;

export const paymentInput = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int(),
  voucherCode: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
  externalRef: z.preprocess(emptyToNull, z.string().trim().max(120).nullable().optional()),
});
export type PaymentInput = z.infer<typeof paymentInput>;

export const invoiceInput = z.object({
  kind: z.enum(CREATABLE_KINDS),
  patientId: optUuid,
  billingContactId: optUuid,
  issuedAt: isoDate,
  /** leer → Standard-Zahlungsziel der Praxis (Einstellungen → Belege) */
  dueDays: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(MAX_DUE_DAYS).optional()),
  therapeuticConfirmed: z.boolean().default(false),
  notes: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
  lines: z.array(lineInput).min(1, "Mindestens eine Position anlegen").max(100),
  payments: z.array(paymentInput).max(10).default([]),
  /** Anzahlungen (Quittungen, kind = deposit) der Person, die auf diese Rechnung angerechnet werden */
  depositIds: z.array(z.uuid()).max(100).default([]),
});
type ParsedInvoiceInput = z.infer<typeof invoiceInput>;
/** Positionen ohne Termin-/Doku-Bezug und ohne Anzahlungen dürfen die Felder weglassen. */
export type InvoiceInput = Omit<ParsedInvoiceInput, "depositIds" | "lines"> & {
  depositIds?: string[];
  lines: (Omit<LineInput, "appointmentId"> & { appointmentId?: string | null })[];
};

type OrgRow = typeof organizations.$inferSelect;

async function loadOrg(tx: Tx, org: string): Promise<OrgRow> {
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  if (!o) throw new InvoiceError("Praxis nicht gefunden.");
  return o;
}

/**
 * Kassenvorgang (Bar, Karte, Gutschein) über die TSE signieren (KassenSichV: jeder Vorgang des Aufzeichnungssystems).
 * Solange kein zertifizierter TSE-Vertrag besteht, läuft der Mock (Test-Signatur) – für echten Betrieb ist eine echte
 * TSE Pflicht. Die vollständige Signatur landet in fiscal_transactions; bei Bar zusätzlich die Kurzreferenz in
 * payments.external_ref (Anzeige/Altbestand).
 */
async function signPayment(inv: { id: string; number?: string | null }, method: string, amountCents: number, vatGroups: { rate: number; grossCents: number }[]) {
  try {
    return await signRegisterPayment({ reference: inv.number ?? inv.id, method, amountCents, vatGroups });
  } catch (e) {
    if (e instanceof FiscalSignError) throw new InvoiceError(e.message);
    throw e;
  }
}

/**
 * Bucht Zahlungen auf eine (bereits ausgestellte) Rechnung und aktualisiert paidCents/Status.
 * Gutschein-Zahlungen werden gegen das Restguthaben geprüft (Zeile wird gesperrt).
 */
async function applyPayments(
  tx: Tx,
  org: string,
  userId: string,
  inv: { id: string; totalCents: number; paidCents: number; number?: string | null },
  list: PaymentInput[],
  today: string,
  vatGroups: { rate: number; grossCents: number }[] = [],
) {
  if (!list.length) return { paidCents: inv.paidCents, status: statusFromPayments(inv.totalCents, inv.paidCents) };
  const err = validatePayments(inv.totalCents - inv.paidCents, list.map((p) => p.amountCents));
  if (err) throw new InvoiceError(err);

  const voucherUse = new Map<string, number>();
  for (const p of list) {
    let voucherId: string | null = null;
    if (p.method === "voucher") {
      if (!p.voucherCode) throw new InvoiceError("Bitte den Gutscheincode angeben.");
      const [v] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.organizationId, org), eq(sql`upper(${vouchers.code})`, String(p.voucherCode).trim().toUpperCase())))
        .for("update");
      if (!v) throw new InvoiceError(`Gutschein ${p.voucherCode} nicht gefunden.`);
      if (p.amountCents > 0 && v.validUntil < today) throw new InvoiceError(`Gutschein ${v.code} ist abgelaufen (${dateDe(v.validUntil)}).`);
      const used = await tx
        .select({ amountCents: payments.amountCents })
        .from(payments)
        .where(and(eq(payments.organizationId, org), eq(payments.voucherId, v.id)));
      const balance = voucherBalance(v.amountCents, used) - (voucherUse.get(v.id) ?? 0);
      if (p.amountCents > balance) throw new InvoiceError(`Restguthaben von ${v.code} reicht nicht (${(balance / 100).toFixed(2).replace(".", ",")} €).`);
      if (balance - p.amountCents > v.amountCents) throw new InvoiceError("Erstattung übersteigt den Gutscheinwert.");
      voucherUse.set(v.id, (voucherUse.get(v.id) ?? 0) + p.amountCents);
      voucherId = v.id;
    }
    let externalRef = p.externalRef ?? null;
    // TSE-Kurzreferenzen vergibt nur der Server (sonst ließe sich eine Signatur vortäuschen)
    if (externalRef?.toLowerCase().startsWith("tse:")) throw new InvoiceError("Die Referenz darf nicht mit „tse:“ beginnen.");
    let signed: SignedPayment | null = null;
    if (needsSignature(p.method)) {
      signed = await signPayment(inv, p.method, p.amountCents, vatGroups);
      if (p.method === "cash") externalRef = fiscalRef(signed.signature);
    }
    await tx.insert(payments).values({
      ...(signed ? { id: signed.paymentId } : {}),
      organizationId: org,
      invoiceId: inv.id,
      method: p.method,
      amountCents: p.amountCents,
      voucherId,
      externalRef,
      createdBy: userId,
    });
    if (signed) await storeSignature(tx, org, signed);
  }
  const paidCents = inv.paidCents + list.reduce((s, p) => s + p.amountCents, 0);
  const status = statusFromPayments(inv.totalCents, paidCents);
  await tx
    .update(invoices)
    .set({ paidCents, status })
    .where(and(eq(invoices.organizationId, org), eq(invoices.id, inv.id)));
  return { paidCents, status };
}

/**
 * Doppelabrechnung verhindern: Jede Behandlung (treatment_record) und jeder Termin darf nur in einer nicht
 * stornierten Rechnung stehen (Anzahlungs-Quittungen zählen nicht – sie werden auf die Rechnung angerechnet).
 * Termin und zugehöriger Doku-Eintrag gelten als dieselbe Leistung. Pro Praxis serialisiert (Advisory-Lock), damit
 * zwei gleichzeitige Rechnungen dieselbe Behandlung nicht beide abrechnen. Behandlung/Termin müssen zur Person bzw.
 * zum Pflegeheim gehören.
 */
async function assertNotInvoiced(tx: Tx, org: string, recordIds: string[], appointmentIds: string[], patientId: string | null, billingContactId: string | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invoice-records:${org}`}))`);
  const belongs = (p: string | null, careHomeId: string | null) => (patientId && p === patientId) || (billingContactId && careHomeId === billingContactId);
  const recs = recordIds.length
    ? await tx
        .select({ id: treatmentRecords.id, patientId: treatmentRecords.patientId, treatedAt: treatmentRecords.treatedAt, appointmentId: treatmentRecords.appointmentId, careHomeId: patients.careHomeId })
        .from(treatmentRecords)
        .innerJoin(patients, eq(patients.id, treatmentRecords.patientId))
        .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.id, recordIds)))
    : [];
  if (recs.length !== recordIds.length) throw new InvoiceError("Behandlung zur Position nicht gefunden.");
  for (const r of recs) {
    if (!belongs(r.patientId, r.careHomeId)) throw new InvoiceError(`Die Behandlung vom ${dateDe(r.treatedAt)} gehört nicht zu diesem Rechnungsempfänger.`);
  }
  const appts = appointmentIds.length
    ? await tx
        .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt, careHomeId: patients.careHomeId })
        .from(appointments)
        .leftJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(eq(appointments.organizationId, org), inArray(appointments.id, appointmentIds)))
    : [];
  if (appts.length !== appointmentIds.length) throw new InvoiceError("Termin zur Position nicht gefunden.");
  for (const a of appts) {
    if (!belongs(a.patientId, a.careHomeId)) throw new InvoiceError(`Der Termin vom ${dateDe(a.startsAt)} gehört nicht zu diesem Rechnungsempfänger.`);
  }
  // Termin ↔ Doku-Eintrag: beide Richtungen einbeziehen
  const allAppts = [...new Set([...appointmentIds, ...recs.map((r) => r.appointmentId).filter((x): x is string => !!x)])];
  const linkedRecs = allAppts.length
    ? await tx
        .select({ id: treatmentRecords.id, appointmentId: treatmentRecords.appointmentId })
        .from(treatmentRecords)
        .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.appointmentId, allAppts)))
    : [];
  const allRecs = [...new Set([...recordIds, ...linkedRecs.map((r) => r.id)])];
  const conds: SQL[] = [];
  if (allRecs.length) conds.push(inArray(invoiceLines.treatmentRecordId, allRecs));
  if (allAppts.length) conds.push(inArray(invoiceLines.appointmentId, allAppts));
  if (!conds.length) return;
  const billed = await tx
    .select({ recordId: invoiceLines.treatmentRecordId, appointmentId: invoiceLines.appointmentId, number: invoices.number })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.organizationId, org), or(...conds), notInArray(invoices.status, ["cancelled", "draft"]), ne(invoices.kind, "deposit")))
    .limit(1);
  if (billed[0]) {
    const b = billed[0];
    const recId = b.recordId && allRecs.includes(b.recordId) ? b.recordId : null;
    const r = recs.find((x) => x.id === recId || (b.appointmentId && x.appointmentId === b.appointmentId));
    const a = appts.find((x) => x.id === b.appointmentId || linkedRecs.some((l) => l.id === recId && l.appointmentId === x.id));
    const when = r ? `Die Behandlung vom ${dateDe(r.treatedAt)}` : a ? `Der Termin vom ${dateDe(a.startsAt)}` : "Die Behandlung";
    throw new InvoiceError(`${when} ist bereits in Rechnung ${b.number} abgerechnet.`);
  }
}

/** Anzahlungen der Person, die noch auf keine (gültige) Rechnung angerechnet sind. */
export async function openDepositsFor(tx: Tx, org: string, patientId: string) {
  return tx
    .select({ id: invoices.id, number: invoices.number, issuedAt: invoices.issuedAt, totalCents: invoices.totalCents })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), eq(invoices.patientId, patientId), eq(invoices.kind, "deposit"), eq(invoices.status, "paid"), isNull(invoices.collectiveInvoiceId)))
    .orderBy(asc(invoices.issuedAt), asc(invoices.number));
}

/** Anzahlungen anrechnen (gesperrt, nur offene der Person); liefert die Summe. */
async function creditDeposits(tx: Tx, org: string, invoiceId: string, patientId: string | null, ids: string[], totalCents: number) {
  if (!ids.length) return 0;
  if (!patientId) throw new InvoiceError("Anzahlungen können nur auf die Rechnung einer Person angerechnet werden.");
  const unique = [...new Set(ids)];
  const deps = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), inArray(invoices.id, unique)))
    .orderBy(asc(invoices.issuedAt))
    .for("update");
  if (deps.length !== unique.length) throw new InvoiceError("Anzahlung nicht gefunden.");
  for (const d of deps) {
    if (d.kind !== "deposit" || d.patientId !== patientId) throw new InvoiceError(`${d.number ?? "Beleg"} ist keine Anzahlung dieser Person.`);
    if (d.status !== "paid") throw new InvoiceError(`Die Anzahlung ${d.number} ist storniert oder nicht bezahlt.`);
    if (d.collectiveInvoiceId) throw new InvoiceError(`Die Anzahlung ${d.number} ist bereits auf eine andere Rechnung angerechnet.`);
  }
  const sum = deps.reduce((s, d) => s + d.totalCents, 0);
  if (sum > totalCents) throw new InvoiceError("Die angerechneten Anzahlungen übersteigen den Rechnungsbetrag.");
  await tx.update(invoices).set({ collectiveInvoiceId: invoiceId }).where(and(eq(invoices.organizationId, org), inArray(invoices.id, unique)));
  await tx
    .update(invoices)
    .set({ paidCents: sum, status: statusFromPayments(totalCents, sum) })
    .where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
  return sum;
}

/**
 * Legt eine Rechnung an und stellt sie sofort aus (GoBD: Entwurf → Positionen → Nummer + Summen
 * in derselben Transaktion; danach sind Nummer/Beträge per DB-Trigger unveränderbar).
 */
export async function createInvoice(auth: AuthContext, input: InvoiceInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (input.issuedAt > today) throw new InvoiceError("Das Rechnungsdatum darf nicht in der Zukunft liegen.");
  if (input.kind === "collective" && !input.billingContactId && !input.patientId) {
    throw new InvoiceError("Für eine Sammelrechnung bitte eine Patient:in oder einen Rechnungsempfänger (z. B. Pflegeheim) wählen.");
  }
  if (input.kind !== "collective" && !input.patientId) throw new InvoiceError("Bitte einen Patienten wählen.");
  const depositIds = input.depositIds ?? [];
  if (depositIds.length && input.kind !== "invoice" && input.kind !== "collective") {
    throw new InvoiceError("Anzahlungen können nur auf eine Rechnung oder Sammelrechnung angerechnet werden.");
  }

  const result = await withOrg(org, async (tx) => {
    const o = await loadOrg(tx, org);
    const smallBusiness = o.smallBusiness;

    if (input.patientId) {
      const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
      if (!p) throw new InvoiceError("Patient nicht gefunden.");
    }
    if (input.billingContactId) {
      const [b] = await tx
        .select({ id: billingContacts.id })
        .from(billingContacts)
        .where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, input.billingContactId)));
      if (!b) throw new InvoiceError("Rechnungsempfänger nicht gefunden.");
    }

    const serviceIds = [...new Set(input.lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
    const svcRows = serviceIds.length
      ? await tx.select().from(services).where(and(eq(services.organizationId, org), inArray(services.id, serviceIds)))
      : [];
    const svc = new Map(svcRows.map((s) => [s.id, s]));

    const lines = input.lines.map((l, i) => {
      const s = l.serviceId ? svc.get(l.serviceId) : undefined;
      if (l.serviceId && !s) throw new InvoiceError(`Position ${i + 1}: Leistung nicht gefunden.`);
      if (!isVatRate(l.vatRate)) throw new InvoiceError(`Position ${i + 1}: Steuersatz muss 0, 7 oder 19 % sein.`);
      // Eine Leistung mit 19 % darf nicht auf 0 % gesetzt werden; 0 % darf auf 19 % (kein therapeutisches Ziel).
      if (s && l.vatRate !== s.vatRate && l.vatRate !== 19) {
        throw new InvoiceError(`Position ${i + 1}: Für „${s.name}“ sind nur ${s.vatRate} % oder 19 % möglich.`);
      }
      const description = (l.description || s?.name || "").trim();
      if (!description) throw new InvoiceError(`Position ${i + 1}: Beschreibung fehlt.`);
      const unitPriceCents = s ? s.priceCents : l.unitPriceCents;
      const vatRate = effectiveVatRate(l.vatRate, { smallBusiness });
      return {
        serviceId: s?.id ?? null,
        treatmentRecordId: l.treatmentRecordId ?? null,
        appointmentId: l.appointmentId ?? null,
        description,
        quantity: l.quantity,
        factor: l.factor,
        unitPriceCents,
        vatRate,
        totalCents: lineTotalCents(unitPriceCents, l.quantity, l.factor),
        // Freitext mit 0 % gilt ebenfalls als Heilbehandlung – außer beim Ausfallhonorar (nicht steuerbar)
        requiresTherapeuticPurpose: input.kind === "no_show_fee" ? false : s ? s.requiresTherapeuticPurpose : true,
      };
    });

    const recordIds = [...new Set(lines.map((l) => l.treatmentRecordId).filter((x): x is string => !!x))];
    const appointmentIds = [...new Set(lines.map((l) => l.appointmentId).filter((x): x is string => !!x))];
    if (recordIds.length || appointmentIds.length) await assertNotInvoiced(tx, org, recordIds, appointmentIds, input.patientId ?? null, input.billingContactId ?? null);

    const needsConfirm = needsTherapeuticConfirmation(lines, { smallBusiness });
    if (needsConfirm && !input.therapeuticConfirmed) {
      throw new InvoiceError(
        "USt-Wächter: 0 % nur bei Heilbehandlung mit therapeutischem Ziel. Bitte bestätigen oder die Position auf 19 % umstellen.",
      );
    }

    const totals = computeTotals(lines);
    if (totals.totalCents <= 0) throw new InvoiceError("Der Rechnungsbetrag muss größer 0 sein.");
    if (input.kind === "receipt") {
      const sum = input.payments.reduce((s, p) => s + p.amountCents, 0);
      if (sum !== totals.totalCents) throw new InvoiceError("Eine Quittung muss sofort vollständig bezahlt werden.");
    }

    const noteParts: string[] = [];
    if (input.notes) noteParts.push(input.notes);
    if (needsConfirm && input.therapeuticConfirmed) {
      noteParts.push(`${INTERNAL_NOTE_PREFIX}USt-Wächter: ${THERAPEUTIC_LABEL} – bestätigt von ${auth.user.name} am ${dateDe(new Date())}.`);
    }

    // 1) Entwurf
    const [draft] = await tx
      .insert(invoices)
      .values({
        organizationId: org,
        patientId: input.patientId ?? null,
        billingContactId: input.billingContactId ?? null,
        kind: input.kind,
        status: "draft",
        notes: noteParts.join("\n") || null,
        createdBy: auth.user.id,
      })
      .returning({ id: invoices.id });

    // 2) Positionen
    await tx.insert(invoiceLines).values(
      lines.map((l, i) => ({
        organizationId: org,
        invoiceId: draft.id,
        serviceId: l.serviceId,
        treatmentRecordId: l.treatmentRecordId,
        appointmentId: l.appointmentId,
        description: l.description,
        quantity: String(l.quantity),
        factor: String(l.factor),
        unitPriceCents: l.unitPriceCents,
        vatRate: l.vatRate,
        totalCents: l.totalCents,
        position: i + 1,
      })),
    );

    // 3) Ausstellen: Nummer + Summen
    const number = await nextNumber(tx, org, input.kind, Number(input.issuedAt.slice(0, 4)));
    const dueAt = input.kind === "receipt" ? input.issuedAt : addDaysIso(input.issuedAt, input.dueDays ?? readDocumentSettings(o.settings as Record<string, unknown> | null).dueDays);
    await tx
      .update(invoices)
      .set({
        number,
        status: "issued",
        issuedAt: input.issuedAt,
        dueAt,
        netCents: totals.netCents,
        vatCents: totals.vatCents,
        totalCents: totals.totalCents,
      })
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, draft.id)));

    // 4) Anzahlungen (Quittungen) anrechnen – kein neuer Zahlungseingang, das Geld kam schon mit der Quittung
    const depositCents = await creditDeposits(tx, org, draft.id, input.patientId ?? null, depositIds, totals.totalCents);

    // 5) Zahlungen (Mischzahlung möglich)
    const paid = await applyPayments(tx, org, auth.user.id, { id: draft.id, number, totalCents: totals.totalCents, paidCents: depositCents }, input.payments, today, totals.groups);
    return { id: draft.id, number, totalCents: totals.totalCents, depositCents, ...paid };
  });

  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.create",
    entity: "invoice",
    entityId: result.id,
    meta: { number: result.number, kind: input.kind, totalCents: result.totalCents, payments: input.payments.length, deposits: depositIds.length, depositCents: result.depositCents },
  });
  return result;
}

export const depositInput = z.object({
  patientId: z.uuid({ error: "Bitte eine Patient:in wählen." }),
  appointmentId: optUuid,
  treatmentRecordId: optUuid,
  description: z.string().trim().min(3, "Bitte einen Text für die Quittung angeben.").max(300),
  amountCents: z.number().int().min(1, "Betrag fehlt").max(10_000_000, "Betrag zu hoch"),
  vatRate: z.coerce.number().int(),
  method: z.enum(DEPOSIT_METHODS),
  notes: z.preprocess(emptyToNull, z.string().trim().max(1000).nullable().optional()),
});
export type DepositInput = z.infer<typeof depositInput>;

/**
 * Quittung über eine Anzahlung (z. B. bar beim Termin), die später auf die Sammelrechnung der Person angerechnet
 * wird. Wie jede Rechnung sofort ausgestellt (eigener Nummernkreis „AZ“), unveränderbar und voll bezahlt; Bar/Karte
 * laufen über denselben Kassen-/TSE-Weg wie jede andere Zahlung (applyPayments). Termin-/Doku-Bezug steht an der
 * Position (nur zur Nachvollziehbarkeit – die Leistung selbst wird erst mit der Sammelrechnung abgerechnet).
 */
export async function createDeposit(auth: AuthContext, input: DepositInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (!isVatRate(input.vatRate)) throw new InvoiceError("Steuersatz muss 0, 7 oder 19 % sein.");
  const result = await withOrg(org, async (tx) => {
    const o = await loadOrg(tx, org);
    const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
    if (!p) throw new InvoiceError("Patient nicht gefunden.");
    if (input.appointmentId) {
      const [a] = await tx.select({ patientId: appointments.patientId }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId)));
      if (!a || a.patientId !== input.patientId) throw new InvoiceError("Termin nicht gefunden.");
    }
    if (input.treatmentRecordId) {
      const [r] = await tx.select({ patientId: treatmentRecords.patientId }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.id, input.treatmentRecordId)));
      if (!r || r.patientId !== input.patientId) throw new InvoiceError("Behandlung nicht gefunden.");
    }
    const vatRate = effectiveVatRate(input.vatRate, { smallBusiness: o.smallBusiness });
    const line = { totalCents: input.amountCents, vatRate };
    const totals = computeTotals([line]);
    const [draft] = await tx
      .insert(invoices)
      .values({ organizationId: org, patientId: input.patientId, kind: "deposit", status: "draft", notes: input.notes ?? null, createdBy: auth.user.id })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLines).values({
      organizationId: org,
      invoiceId: draft.id,
      appointmentId: input.appointmentId ?? null,
      treatmentRecordId: input.treatmentRecordId ?? null,
      description: input.description,
      quantity: "1",
      factor: "1",
      unitPriceCents: input.amountCents,
      vatRate,
      totalCents: input.amountCents,
      position: 1,
    });
    const number = await nextNumber(tx, org, "deposit", Number(today.slice(0, 4)));
    await tx
      .update(invoices)
      .set({ number, status: "issued", issuedAt: today, dueAt: today, netCents: totals.netCents, vatCents: totals.vatCents, totalCents: totals.totalCents })
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, draft.id)));
    const paid = await applyPayments(
      tx,
      org,
      auth.user.id,
      { id: draft.id, number, totalCents: totals.totalCents, paidCents: 0 },
      [{ method: input.method, amountCents: totals.totalCents, voucherCode: null, externalRef: null }],
      today,
      totals.groups,
    );
    return { id: draft.id, number, totalCents: totals.totalCents, ...paid };
  });
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.deposit_create",
    entity: "invoice",
    entityId: result.id,
    meta: { number: result.number, totalCents: result.totalCents, method: input.method, appointmentId: input.appointmentId ?? null, treatmentRecordId: input.treatmentRecordId ?? null },
  });
  return result;
}

export async function addPayments(auth: AuthContext, invoiceId: string, list: PaymentInput[]) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!list.length) throw new InvoiceError("Keine Zahlung angegeben.");
  const result = await withOrg(org, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)))
      .for("update");
    if (!inv) throw new InvoiceError("Rechnung nicht gefunden.");
    if (inv.status !== "issued" && inv.status !== "partially_paid") throw new InvoiceError("Für diese Rechnung kann keine Zahlung erfasst werden.");
    const vatLines = await tx
      .select({ totalCents: invoiceLines.totalCents, vatRate: invoiceLines.vatRate })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.organizationId, org), eq(invoiceLines.invoiceId, inv.id)));
    return applyPayments(tx, org, auth.user.id, inv, list, berlinDateIso(), computeTotals(vatLines).groups);
  });
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.pay",
    entity: "invoice",
    entityId: invoiceId,
    meta: { amounts: list.map((p) => p.amountCents), methods: list.map((p) => p.method), status: result.status },
  });
  return result;
}

/** Zahlungslink bei SumUp deaktivieren (best effort; Fehler nur protokollieren). */
async function deactivateProviderCheckout(org: string, checkoutRef: string) {
  const [kind, ...rest] = checkoutRef.split(":");
  const id = rest.join(":");
  if (kind !== "checkout" || !id) {
    // TODO: laufende Terminal-Zahlung abbrechen (SumUp Cloud API: POST /v0.1/merchants/{code}/readers/{id}/terminate)
    return;
  }
  try {
    const { adapterFor } = await import("./integrations");
    const port = await adapterFor(org, "sumup");
    if (port.deactivateCheckout) await port.deactivateCheckout(id);
    await withOrg(org, (tx) => tx.insert(syncLog).values({ organizationId: org, provider: "sumup", direction: "out", ok: true, message: "Zahlungslink nach Storno deaktiviert" }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unbekannt";
    await withOrg(org, (tx) =>
      tx.insert(syncLog).values({ organizationId: org, provider: "sumup", direction: "out", ok: false, message: `Zahlungslink konnte nach Storno nicht deaktiviert werden: ${msg}`.slice(0, 500) }),
    ).catch(() => undefined);
  }
}

/**
 * Storno: erzeugt eine Stornorechnung (Gutschrift) mit negativen Beträgen und setzt die
 * Originalrechnung auf „storniert“ (nur der Status ändert sich – GoBD-konform).
 */
export async function cancelInvoice(auth: AuthContext, invoiceId: string, reason: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  const result = await withOrg(org, async (tx) => {
    const [orig] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)))
      .for("update");
    if (!orig) throw new InvoiceError("Rechnung nicht gefunden.");
    if (orig.kind === "credit_note") throw new InvoiceError("Eine Stornorechnung kann nicht storniert werden.");
    if (orig.status === "draft" || orig.status === "cancelled") throw new InvoiceError("Diese Rechnung kann nicht storniert werden.");
    if (orig.kind === "deposit" && orig.collectiveInvoiceId) {
      const [target] = await tx
        .select({ number: invoices.number, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.organizationId, org), eq(invoices.id, orig.collectiveInvoiceId)));
      if (target && target.status !== "cancelled") {
        throw new InvoiceError(`Die Anzahlung ist auf ${target.number} angerechnet. Bitte zuerst diese Rechnung stornieren.`);
      }
    }
    // angerechnete Anzahlungen: werden wieder frei (für eine neue Sammelrechnung) – nur echte Zahlungen sind zu erstatten
    const credited = orig.kind === "deposit"
      ? []
      : await tx
          .select({ id: invoices.id, number: invoices.number, totalCents: invoices.totalCents })
          .from(invoices)
          .where(and(eq(invoices.organizationId, org), eq(invoices.collectiveInvoiceId, orig.id), eq(invoices.kind, "deposit")));
    const creditedCents = credited.reduce((sum, d) => sum + d.totalCents, 0);
    const origLines = await tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.organizationId, org), eq(invoiceLines.invoiceId, orig.id)))
      .orderBy(asc(invoiceLines.position));

    const [draft] = await tx
      .insert(invoices)
      .values({
        organizationId: org,
        patientId: orig.patientId,
        billingContactId: orig.billingContactId,
        kind: "credit_note",
        status: "draft",
        cancelsInvoiceId: orig.id,
        notes: `Storno zu ${orig.number} vom ${dateDe(orig.issuedAt)}.${reason ? ` Grund: ${reason}` : ""}${
          credited.length ? `\nAngerechnete Anzahlungen (${credited.map((d) => d.number).join(", ")}) bleiben gültig und werden auf die neue Rechnung angerechnet.` : ""
        }`,
        createdBy: auth.user.id,
      })
      .returning({ id: invoices.id });

    const neg = negateLines(origLines);
    if (neg.length) {
      await tx.insert(invoiceLines).values(
        neg.map((l) => ({
          organizationId: org,
          invoiceId: draft.id,
          serviceId: l.serviceId,
          description: l.description,
          quantity: l.quantity,
          factor: l.factor,
          unitPriceCents: l.unitPriceCents,
          vatRate: l.vatRate,
          totalCents: l.totalCents,
          position: l.position,
        })),
      );
    }
    const totals = computeTotals(neg);
    const number = await nextNumber(tx, org, "credit_note", Number(today.slice(0, 4)));
    const paidCents = creditNoteSettlement(orig.totalCents, orig.paidCents - creditedCents);
    await tx
      .update(invoices)
      .set({
        number,
        status: statusFromPayments(totals.totalCents, paidCents),
        issuedAt: today,
        dueAt: today,
        netCents: totals.netCents,
        vatCents: totals.vatCents,
        totalCents: totals.totalCents,
        paidCents,
      })
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, draft.id)));
    // Storno: offene Zahlungslinks/Terminal-Zuordnung entfernen (eine spätere SumUp-Zahlung wird dann nicht gebucht, sondern gemeldet)
    await tx
      .update(invoices)
      .set({ status: "cancelled", paymentLinkUrl: null, checkoutRef: null })
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, orig.id)));
    if (credited.length) {
      await tx
        .update(invoices)
        .set({ collectiveInvoiceId: null })
        .where(and(eq(invoices.organizationId, org), inArray(invoices.id, credited.map((d) => d.id))));
    }
    return { id: draft.id, number, originalNumber: orig.number, refundCents: orig.paidCents - creditedCents, checkoutRef: orig.checkoutRef, releasedDeposits: credited.length };
  });
  if (result.checkoutRef) await deactivateProviderCheckout(org, result.checkoutRef);
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.cancel",
    entity: "invoice",
    entityId: invoiceId,
    meta: { creditNoteId: result.id, creditNoteNumber: result.number, refundCents: result.refundCents, releasedDeposits: result.releasedDeposits },
  });
  return result;
}

export type InvoiceFilter = "open" | "paid" | "all";

export async function listInvoices(auth: AuthContext, opts: { filter?: InvoiceFilter; q?: string; limit?: number } = {}) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const where: SQL[] = [eq(invoices.organizationId, org), sql`${invoices.status} <> 'draft'`];
    if (opts.filter === "open") where.push(inArray(invoices.status, ["issued", "partially_paid"]));
    if (opts.filter === "paid") where.push(eq(invoices.status, "paid"));
    const q = opts.q?.trim();
    if (q) {
      const like = `%${q}%`;
      where.push(
        or(ilike(invoices.number, like), ilike(patients.lastName, like), ilike(patients.firstName, like), ilike(billingContacts.name, like))!,
      );
    }
    const cash = tx
      .select({ invoiceId: payments.invoiceId, cashCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`.as("cash_cents") })
      .from(payments)
      .where(eq(payments.organizationId, org))
      .groupBy(payments.invoiceId)
      .as("cash");
    const rows = await tx
      .select({
        invoice: invoices,
        cashCents: cash.cashCents,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        billingName: billingContacts.name,
      })
      .from(invoices)
      .leftJoin(patients, eq(patients.id, invoices.patientId))
      .leftJoin(billingContacts, eq(billingContacts.id, invoices.billingContactId))
      .leftJoin(cash, eq(cash.invoiceId, invoices.id))
      .where(and(...where))
      .orderBy(desc(invoices.issuedAt), desc(invoices.number))
      .limit(opts.limit ?? 500);
    const list = rows.map((r) => ({
      ...r.invoice,
      cashCents: Number(r.cashCents ?? 0),
      name: r.billingName
        ? `${r.billingName}${r.patientLast ? ` (${[r.patientFirst, r.patientLast].filter(Boolean).join(" ")})` : ""}`
        : [r.patientFirst, r.patientLast].filter(Boolean).join(" ") || "–",
    }));
    // Anzahlungen sind in der späteren Sammelrechnung enthalten – nicht doppelt als Rechnungsbetrag zählen
    const active = list.filter((i) => i.status !== "cancelled" && i.kind !== "credit_note" && i.kind !== "deposit");
    return {
      rows: list,
      totals: {
        count: list.length,
        totalCents: active.reduce((s, i) => s + i.totalCents, 0),
        /** tatsächliche Zahlungseingänge (abzgl. Erstattungen) der angezeigten Belege */
        paidCents: list.reduce((s, i) => s + i.cashCents, 0),
        openCents: list
          .filter((i) => i.status === "issued" || i.status === "partially_paid")
          .reduce((s, i) => s + i.totalCents - i.paidCents, 0),
      },
    };
  });
}

/** Lädt eine Rechnung mit allem, was Druckansicht und PDF brauchen (innerhalb von withOrg). */
export async function loadInvoiceBundle(tx: Tx, org: string, id: string) {
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, id)));
  if (!inv) return null;
  const lines = await tx.select().from(invoiceLines).where(and(eq(invoiceLines.organizationId, org), eq(invoiceLines.invoiceId, id))).orderBy(asc(invoiceLines.position));
  const pays = await tx
    .select({ payment: payments, voucherCode: vouchers.code })
    .from(payments)
    .leftJoin(vouchers, eq(vouchers.id, payments.voucherId))
    .where(and(eq(payments.organizationId, org), eq(payments.invoiceId, id)))
    .orderBy(asc(payments.paidAt));
  const o = await loadOrg(tx, org);
  const patient = inv.patientId
    ? await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))).then((r) => r[0] ?? null)
    : null;
  const billing = inv.billingContactId
    ? await tx
        .select()
        .from(billingContacts)
        .where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId)))
        .then((r) => r[0] ?? null)
    : null;
  // Storno-Beziehung in beide Richtungen
  const related = await tx
    .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, cancelsInvoiceId: invoices.cancelsInvoiceId })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, org),
        or(eq(invoices.cancelsInvoiceId, id), inv.cancelsInvoiceId ? eq(invoices.id, inv.cancelsInvoiceId) : sql`false`),
      ),
    );
  // Anzahlungen: auf diese Rechnung angerechnete Quittungen bzw. (bei einer Anzahlung) die Rechnung, auf die sie angerechnet ist
  const deposits =
    inv.kind === "invoice" || inv.kind === "collective"
      ? await tx
          .select({ id: invoices.id, number: invoices.number, issuedAt: invoices.issuedAt, totalCents: invoices.totalCents })
          .from(invoices)
          .where(and(eq(invoices.organizationId, org), eq(invoices.collectiveInvoiceId, id), eq(invoices.kind, "deposit")))
          .orderBy(asc(invoices.issuedAt), asc(invoices.number))
      : [];
  const creditedTo =
    inv.kind === "deposit" && inv.collectiveInvoiceId
      ? await tx
          .select({ id: invoices.id, number: invoices.number, status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.organizationId, org), eq(invoices.id, inv.collectiveInvoiceId)))
          .then((r) => r[0] ?? null)
      : null;
  // Leistungsdaten (Berliner Kalendertage) aus verknüpften Terminen bzw. Doku-Einträgen – für „Behandlung am …“
  const apptIds = [...new Set(lines.map((l) => l.appointmentId).filter((x): x is string => !!x))];
  const recIds = [...new Set(lines.map((l) => l.treatmentRecordId).filter((x): x is string => !!x))];
  const apptDays = apptIds.length
    ? await tx.select({ at: appointments.startsAt }).from(appointments).where(and(eq(appointments.organizationId, org), inArray(appointments.id, apptIds)))
    : [];
  const recDays = recIds.length
    ? await tx.select({ at: treatmentRecords.treatedAt }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.id, recIds)))
    : [];
  const serviceDates = [...new Set([...apptDays, ...recDays].map((r) => berlinDateIso(r.at)))].sort();
  return {
    invoice: inv,
    lines,
    deposits,
    serviceDates,
    creditedTo,
    payments: pays.map((p) => ({ ...p.payment, voucherCode: p.voucherCode })),
    organization: o,
    patient,
    billingContact: billing,
    cancelledBy: related.find((r) => r.cancelsInvoiceId === id) ?? null,
    cancels: related.find((r) => r.id === inv.cancelsInvoiceId) ?? null,
  };
}
export type InvoiceBundle = NonNullable<Awaited<ReturnType<typeof loadInvoiceBundle>>>;

export async function getInvoice(auth: AuthContext, id: string) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(id).success) return null;
  const data = await withOrg(org, (tx) => loadInvoiceBundle(tx, org, id));
  if (data) await audit({ organizationId: org, userId: auth.user.id, action: "invoice.read", entity: "invoice", entityId: id });
  return data;
}

/** Stammdaten für das Rechnungsformular. */
export async function invoiceFormData(auth: AuthContext, preselectPatientId?: string | null) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const cols = {
      id: patients.id,
      number: patients.number,
      firstName: patients.firstName,
      lastName: patients.lastName,
      billingContactId: patients.billingContactId,
      careHomeId: patients.careHomeId,
    };
    const recent = await (tx
        .select(cols)
        .from(patients)
        .where(and(eq(patients.organizationId, org), isNull(patients.archivedAt)))
        .orderBy(desc(patients.updatedAt))
        .limit(200));
    const svc = await (tx
        .select()
        .from(services)
        .where(and(eq(services.organizationId, org), eq(services.active, true)))
        .orderBy(asc(services.category), asc(services.name)));
    const contacts = await (tx.select().from(billingContacts).where(eq(billingContacts.organizationId, org)).orderBy(asc(billingContacts.name)));
    const o = await (loadOrg(tx, org));
    // offene Anzahlungen (Quittungen) – werden auf Rechnung/Sammelrechnung derselben Person angerechnet
    const deposits = await tx
      .select({ id: invoices.id, patientId: invoices.patientId, number: invoices.number, issuedAt: invoices.issuedAt, totalCents: invoices.totalCents })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.kind, "deposit"), eq(invoices.status, "paid"), isNull(invoices.collectiveInvoiceId)))
      .orderBy(asc(invoices.issuedAt));
    let list = recent;
    if (preselectPatientId && z.uuid().safeParse(preselectPatientId).success && !recent.some((p) => p.id === preselectPatientId)) {
      const extra = await tx.select(cols).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, preselectPatientId)));
      list = [...extra, ...recent];
    }
    list = [...list].sort((a, b) => a.lastName.localeCompare(b.lastName, "de") || (a.firstName ?? "").localeCompare(b.firstName ?? "", "de"));
    return {
      patients: list,
      services: svc.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        priceCents: s.priceCents,
        vatRate: s.vatRate,
        requiresTherapeuticPurpose: s.requiresTherapeuticPurpose,
      })),
      billingContacts: contacts.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      smallBusiness: o.smallBusiness,
      defaultDueDays: readDocumentSettings(o.settings as Record<string, unknown> | null).dueDays,
      today: berlinDateIso(),
      openDeposits: deposits.filter((d): d is typeof d & { patientId: string } => !!d.patientId),
    };
  });
}

/**
 * Übergabe an die Buchhaltung (lexoffice, Voucher-API). Das CRM bleibt führend für Nummern;
 * lexoffice erhält nur den Beleg (Beträge je Steuersatz), keine Positionstexte/medizinischen Details.
 * Der externe Aufruf läuft außerhalb der DB-Transaktion.
 */
export async function pushInvoiceToAccounting(auth: AuthContext, invoiceId: string): Promise<{ ok: boolean; message: string }> {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const prep = await withOrg(org, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
    if (!inv || inv.status === "draft" || !inv.number || !inv.issuedAt) throw new InvoiceError("Rechnung nicht gefunden oder nicht ausgestellt.");
    if (inv.kind === "deposit") throw new InvoiceError("Anzahlungen werden nicht einzeln übertragen – sie sind in der Sammelrechnung enthalten.");
    const lines = await tx
      .select({ totalCents: invoiceLines.totalCents, vatRate: invoiceLines.vatRate })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.organizationId, org), eq(invoiceLines.invoiceId, invoiceId)));
    const [conn] = await tx
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, "lexoffice")));
    return { inv, lines, conn: conn ?? null };
  });
  const { inv, lines, conn } = prep;
  const number = inv.number!;

  let ok = true;
  let message: string;
  let externalId: string | null = null;
  try {
    const adapter = getAdapter("lexoffice", conn ? { provider: "lexoffice", status: conn.status, config: conn.config, secretEnc: conn.secretEnc, organizationId: org } : { status: "mock" });
    const totals = computeTotals(lines);
    const res = await adapter.pushVoucher({
      invoiceId: inv.id,
      number,
      kind: inv.kind,
      date: inv.issuedAt!,
      dueDate: inv.dueAt,
      totalGrossCents: inv.totalCents,
      totalTaxCents: inv.vatCents,
      lines: totals.groups.map((g) => ({ grossCents: g.grossCents, vatRate: g.rate })),
      remark: `${inv.kind === "credit_note" ? "Stornorechnung" : "Rechnung"} ${number}`,
      // TODO: Kontakt (upsertContact) und PDF-Belegbild übergeben, sobald PDF-Erzeugung vorhanden ist
    });
    externalId = res.externalId;
    message = adapter.isMock ? "Schnittstelle im Testmodus – Beleg vorgemerkt" : "Beleg an lexoffice übertragen.";
  } catch (e) {
    ok = false;
    message = e instanceof Error ? `Übertragung fehlgeschlagen: ${e.message}` : "Übertragung fehlgeschlagen.";
  }

  await withOrg(org, async (tx) => {
    await tx.insert(syncLog).values({
      organizationId: org,
      provider: "lexoffice",
      direction: "push",
      entity: "invoice",
      entityId: inv.id,
      ok,
      message: `${number}: ${message}`.slice(0, 500),
    });
    // externalRef/externalSyncedAt sind nicht durch den GoBD-Trigger gesperrt
    if (ok && externalId && conn?.status === "connected") {
      await tx
        .update(invoices)
        .set({ externalRef: externalId, externalSyncedAt: new Date() })
        .where(and(eq(invoices.organizationId, org), eq(invoices.id, inv.id)));
    }
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.push_accounting", entity: "invoice", entityId: invoiceId, meta: { number, ok } });
  return { ok, message };
}
