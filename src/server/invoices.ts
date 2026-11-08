import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import {
  billingContacts,
  integrationConnections,
  invoiceLines,
  invoices,
  organizations,
  patients,
  payments,
  services,
  syncLog,
  vouchers,
} from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import { getAdapter } from "@/integrations/registry";
import { allocateByVat, fiscalRef, getFiscalPort } from "@/integrations/tse";
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
import { CREATABLE_KINDS, INTERNAL_NOTE_PREFIX, PAYMENT_METHODS, THERAPEUTIC_LABEL } from "@/lib/invoice-labels";

export class InvoiceError extends Error {}

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optUuid = z.preprocess(emptyToNull, z.uuid().nullable().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");

export const lineInput = z.object({
  serviceId: optUuid,
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
  dueDays: z.coerce.number().int().min(0).max(120).default(14),
  therapeuticConfirmed: z.boolean().default(false),
  notes: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
  lines: z.array(lineInput).min(1, "Mindestens eine Position anlegen").max(100),
  payments: z.array(paymentInput).max(10).default([]),
});
export type InvoiceInput = z.infer<typeof invoiceInput>;

type OrgRow = typeof organizations.$inferSelect;

async function loadOrg(tx: Tx, org: string): Promise<OrgRow> {
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  if (!o) throw new InvoiceError("Praxis nicht gefunden.");
  return o;
}

/**
 * Barzahlung über die TSE signieren (KassenSichV). Solange kein zertifizierter TSE-Vertrag besteht,
 * läuft der Mock (Referenz „tse:test:…“) – für echten Bargeldeinsatz ist eine echte TSE Pflicht.
 * Die Signaturreferenz landet in payments.external_ref.
 */
async function signCashPayment(inv: { id: string; number?: string | null }, amountCents: number, vatGroups: { rate: number; grossCents: number }[]) {
  const fiscal = getFiscalPort();
  try {
    const reference = inv.number ?? inv.id;
    const { transactionId } = await fiscal.startTransaction({ reference });
    const sig = await fiscal.finishTransaction({
      transactionId,
      reference,
      amounts: allocateByVat(amountCents, vatGroups),
      paymentType: "cash",
      paymentCents: amountCents,
    });
    return fiscalRef(sig);
  } catch (e) {
    throw new InvoiceError(`Barzahlung konnte nicht über die TSE signiert werden: ${e instanceof Error ? e.message : "unbekannter Fehler"}`);
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
    if (p.method === "cash") externalRef = await signCashPayment(inv, p.amountCents, vatGroups);
    await tx.insert(payments).values({
      organizationId: org,
      invoiceId: inv.id,
      method: p.method,
      amountCents: p.amountCents,
      voucherId,
      externalRef,
      createdBy: userId,
    });
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
 * Legt eine Rechnung an und stellt sie sofort aus (GoBD: Entwurf → Positionen → Nummer + Summen
 * in derselben Transaktion; danach sind Nummer/Beträge per DB-Trigger unveränderbar).
 */
export async function createInvoice(auth: AuthContext, input: InvoiceInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (input.issuedAt > today) throw new InvoiceError("Das Rechnungsdatum darf nicht in der Zukunft liegen.");
  if (input.kind === "collective" && !input.billingContactId) {
    throw new InvoiceError("Für eine Sammelrechnung bitte einen Rechnungsempfänger (z. B. Pflegeheim) wählen.");
  }
  if (input.kind !== "collective" && !input.patientId) throw new InvoiceError("Bitte einen Kunden wählen.");

  const result = await withOrg(org, async (tx) => {
    const o = await loadOrg(tx, org);
    const smallBusiness = o.smallBusiness;

    if (input.patientId) {
      const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
      if (!p) throw new InvoiceError("Kunde nicht gefunden.");
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
    const dueAt = input.kind === "receipt" ? input.issuedAt : addDaysIso(input.issuedAt, input.dueDays);
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

    // 4) Zahlungen (Mischzahlung möglich)
    const paid = await applyPayments(tx, org, auth.user.id, { id: draft.id, number, totalCents: totals.totalCents, paidCents: 0 }, input.payments, today, totals.groups);
    return { id: draft.id, number, totalCents: totals.totalCents, ...paid };
  });

  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.create",
    entity: "invoice",
    entityId: result.id,
    meta: { number: result.number, kind: input.kind, totalCents: result.totalCents, payments: input.payments.length },
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
        notes: `Storno zu ${orig.number} vom ${dateDe(orig.issuedAt)}.${reason ? ` Grund: ${reason}` : ""}`,
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
    const paidCents = creditNoteSettlement(orig.totalCents, orig.paidCents);
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
    return { id: draft.id, number, originalNumber: orig.number, refundCents: orig.paidCents, checkoutRef: orig.checkoutRef };
  });
  if (result.checkoutRef) await deactivateProviderCheckout(org, result.checkoutRef);
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "invoice.cancel",
    entity: "invoice",
    entityId: invoiceId,
    meta: { creditNoteId: result.id, creditNoteNumber: result.number, refundCents: result.refundCents },
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
    const active = list.filter((i) => i.status !== "cancelled" && i.kind !== "credit_note");
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
  return {
    invoice: inv,
    lines,
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
      today: berlinDateIso(),
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
