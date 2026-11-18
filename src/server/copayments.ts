import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { invoiceLines, invoices, patients, payments, prescriptions, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { EURO_INPUT_MAX_CENTS } from "@/lib/euro-input";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso, dateDe } from "@/lib/format";
import { computeTotals } from "@/lib/invoice-math";
import { nextNumber } from "@/lib/numbering";
import { PRAXISKASSE_BON_RE } from "@/lib/kasse/model";
import { COPAYMENT_RECEIPT_METHODS, copaymentBreakdown, copaymentExpectedNote, copaymentReceiptLines, type CopaymentBreakdown } from "@/lib/rules/copayment";
import { addDaysIso, copaymentPaidHint, priceSnapshot, type PriceSnapshot } from "@/lib/rules/prescription";
import { positionInfo } from "@/lib/rules/podologie-verguetung";
import { withArchiveCleanup } from "./document-archive";
import { InvoiceError, addPayments, applyPayments, archiveIssued, cancelInvoice, issuedSnapshot, loadOrg, reportInvoiceArchivePending } from "./invoices";

/**
 * Zuzahlungsquittung (GKV Paket B, Teil 2): „Zuzahlung erhalten“ erzeugt einen echten Beleg (Belegart „copayment“,
 * Nummernkreis ZZ) mit Zahlung über den bestehenden Weg (applyPayments): PodoHero-Kasse → TSE-Signatur, Z-Bon und
 * DSFinV-K; eigene Praxiskasse → Vermerk mit Bon-Nr. (payments.register = 'external'). Keine zweite Kasse.
 * Erstattung (z. B. Überzahlung): Quittung stornieren → Stornobeleg mit negativer Zahlung, danach ggf. neu quittieren.
 * Die bisherigen Felder prescriptions.copayment_paid_* sind Altvermerke (nur Anzeige, keine nachträgliche Kassenbuchung).
 */

const euro = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const copaymentReceiptInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  /** null = offene Zuzahlung laut Berechnung */
  amountCents: z.number().int().min(1, "Betrag ungültig.").max(EURO_INPUT_MAX_CENTS, "Betrag ist zu groß.").nullable(),
  method: z.enum(COPAYMENT_RECEIPT_METHODS, { message: "Bitte die Zahlungsart wählen." }),
  /** Betrag über der offenen Zuzahlung ausdrücklich bestätigt (Review R2-14) */
  confirmOverpay: z.boolean().optional(),
  registerReceiptNo: z.preprocess(
    emptyToNull,
    z.string().trim().max(40, "Bon-Nr. der Praxiskasse: höchstens 40 Zeichen.").regex(PRAXISKASSE_BON_RE, "Bon-Nr. der Praxiskasse: nur Buchstaben, Ziffern, „-“ und „/“.").nullable().optional(),
  ),
});
export type CopaymentReceiptInput = z.infer<typeof copaymentReceiptInput>;

export type CopaymentReceiptRow = {
  invoiceId: string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  status: string;
  methods: string[];
  /** Zahlung(en) der eigenen Praxiskasse (Vermerk) */
  external: boolean;
  /** Stornobeleg (Erstattung): Nummer und ob die Erstattung gebucht ist */
  refund: { invoiceId: string; number: string | null; refunded: boolean } | null;
};

/** Behandlungstage einer Verordnung (Berliner Datum, aufsteigend) */
async function treatmentDates(tx: Tx, org: string, prescriptionId: string): Promise<string[]> {
  const rows = await tx
    .select({ treatedAt: treatmentRecords.treatedAt })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, prescriptionId)))
    .orderBy(asc(treatmentRecords.treatedAt));
  return rows.map((r) => berlinDateIso(r.treatedAt));
}

/**
 * Erwartete Zuzahlung: Preis-Snapshot der Verordnung (bei Abrechnungsreife), sonst Schätzung wie beim Anlegen – erbrachte
 * Behandlungstage plus gedachte Folgetage ab heute für die noch offenen Einheiten (Zuzahlung wird oft vorab für die ganze
 * Verordnung kassiert).
 */
export function expectedCopayment(
  vo: Pick<typeof prescriptions.$inferSelect, "positions" | "priceSnapshot" | "insurerIk">,
  patient: { birthDate: string | null; copaymentExemptions: typeof patients.$inferSelect.copaymentExemptions },
  dates: string[],
  today = berlinDateIso(),
): { snapshot: PriceSnapshot; breakdown: CopaymentBreakdown; estimated: boolean } {
  const stored = vo.priceSnapshot as PriceSnapshot | null;
  if (stored?.complete) return { snapshot: stored, breakdown: copaymentBreakdown(stored), estimated: false };
  const maxUnits = Math.max(0, ...vo.positions.map((p) => p.units));
  const future: string[] = [];
  const days = new Set(dates);
  for (let i = 0; days.size + future.length < maxUnits && i < 400; i++) {
    const d = addDaysIso(today, i);
    if (!days.has(d)) future.push(d);
  }
  const snapshot = priceSnapshot({ positions: vo.positions, treatmentDates: [...dates, ...future], birthDate: patient.birthDate, exemptions: patient.copaymentExemptions, computedOn: today, insurerIk: vo.insurerIk });
  return { snapshot, breakdown: copaymentBreakdown(snapshot), estimated: true };
}

/** Zuzahlungsquittungen je Verordnung (inkl. Storno/Erstattung) – für Akte, Leistungsnachweis und Export */
export async function copaymentReceiptsFor(tx: Tx, org: string, prescriptionIds: string[]): Promise<Map<string, CopaymentReceiptRow[]>> {
  const out = new Map<string, CopaymentReceiptRow[]>();
  if (!prescriptionIds.length) return out;
  const rows = await tx
    .select({ id: invoices.id, prescriptionId: invoices.prescriptionId, number: invoices.number, issuedAt: invoices.issuedAt, totalCents: invoices.totalCents, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), inArray(invoices.prescriptionId, prescriptionIds)))
    .orderBy(asc(invoices.issuedAt), asc(invoices.number));
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const pays = await tx
    .select({ invoiceId: payments.invoiceId, method: payments.method, register: payments.register })
    .from(payments)
    .where(and(eq(payments.organizationId, org), inArray(payments.invoiceId, ids)));
  const storno = await tx
    .select({ id: invoices.id, cancels: invoices.cancelsInvoiceId, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), inArray(invoices.cancelsInvoiceId, ids)));
  for (const r of rows) {
    const p = pays.filter((x) => x.invoiceId === r.id);
    const s = storno.find((x) => x.cancels === r.id);
    const list = out.get(r.prescriptionId!) ?? [];
    list.push({
      invoiceId: r.id,
      number: r.number,
      issuedAt: r.issuedAt,
      totalCents: r.totalCents,
      status: r.status,
      methods: [...new Set(p.map((x) => x.method))],
      external: p.some((x) => x.register === "external"),
      refund: s ? { invoiceId: s.id, number: s.number, refunded: s.status === "paid" } : null,
    });
    out.set(r.prescriptionId!, list);
  }
  return out;
}

/** Summe der gültigen (nicht stornierten) Zuzahlungsquittungen */
export const collectedCents = (rows: CopaymentReceiptRow[] | undefined) => (rows ?? []).filter((r) => r.status !== "cancelled" && r.status !== "draft").reduce((s, r) => s + r.totalCents, 0);

/**
 * Zuzahlung quittieren. Recht „Rechnungen schreiben“ (Kassenvorgang am Tresen) – nicht mehr medical.write
 * (offener Punkt 20, Azubis). Sperrt die Verordnung (FOR UPDATE), damit zwei gleichzeitige Quittungen die
 * Heilmittelkosten nicht überschreiten.
 */
export async function createCopaymentReceipt(auth: AuthContext, raw: CopaymentReceiptInput): Promise<{ error: string } | { id: string; number: string; amountCents: number; warning: string | null }> {
  assertCan(auth, "invoices.write");
  const blocked = gkvGuard(auth.organization, "copayment");
  if (blocked) return blocked;
  const parsed = copaymentReceiptInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const input = parsed.data;
  const org = auth.organization.id;
  const today = berlinDateIso();
  try {
    const result = await withArchiveCleanup(org, (pending) =>
      withOrg(org, async (tx) => {
        const [vo] = await tx
          .select()
          .from(prescriptions)
          .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId), eq(prescriptions.patientId, input.patientId)))
          .for("update");
        if (!vo) throw new InvoiceError("Verordnung nicht gefunden.");
        if (vo.status === "cancelled") throw new InvoiceError("Die Verordnung ist storniert – keine Zuzahlung.");
        const [p] = await tx
          .select({ birthDate: patients.birthDate, copaymentExemptions: patients.copaymentExemptions, archivedAt: patients.archivedAt, contactErasedAt: patients.contactErasedAt })
          .from(patients)
          .where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
        if (!p) throw new InvoiceError("Patient nicht gefunden.");
        if (p.archivedAt || p.contactErasedAt) throw new InvoiceError("Für archivierte Patient:innen ist keine Quittung möglich.");
        const existing = (await copaymentReceiptsFor(tx, org, [vo.id])).get(vo.id) ?? [];
        // keine doppelte Erfassung: ein Altvermerk („Zuzahlung erhalten“ vor Paket B) gilt als erhalten (Review R2-5) –
        // eine Quittung dafür gäbe es nur als nachträgliche Kassenbuchung, und die ist ausgeschlossen
        if (vo.copaymentPaidAt) {
          const eur = vo.copaymentPaidCents !== null ? ` (${euro(vo.copaymentPaidCents)})` : "";
          throw new InvoiceError(`Die Zuzahlung ist bereits als Altvermerk „erhalten“ erfasst${eur} – keine zweite Quittung. War der Vermerk falsch (nichts erhalten), zuerst „Vermerk war falsch – nichts erhalten“ mit Begründung setzen.`);
        }
        // Storno ohne gebuchte Erstattung: erst erstatten (am Stornobeleg), dann neu quittieren (Review R2-14)
        const unrefunded = existing.find((r) => r.status === "cancelled" && r.refund && !r.refund.refunded);
        if (unrefunded) throw new InvoiceError(`Die Erstattung zur stornierten Quittung ${unrefunded.number} ist noch nicht gebucht – bitte zuerst am Stornobeleg ${unrefunded.refund!.number} die Erstattung erfassen.`);
        const already = collectedCents(existing);
        const dates = await treatmentDates(tx, org, vo.id);
        const exp = expectedCopayment(vo, p, dates, today);
        // ohne Preis/Positionsnummer lässt sich die Zuzahlung nicht berechnen → frei eingegebener Betrag (Review R2-4)
        const manual = !exp.snapshot.complete;
        let amount: number;
        let open = 0;
        if (manual) {
          if (input.amountCents === null) throw new InvoiceError("Die Zuzahlung lässt sich nicht berechnen (Preis bzw. Positionsnummer fehlt) – bitte den erhaltenen Betrag angeben.");
          amount = input.amountCents;
          if (already + amount > EURO_INPUT_MAX_CENTS) throw new InvoiceError("Betrag ist zu groß.");
        } else {
          if (exp.breakdown.totalCents <= 0) throw new InvoiceError("Laut Berechnung ist keine Zuzahlung fällig (befreit, unter 18 oder ohne zuzahlungspflichtige Position).");
          open = exp.breakdown.totalCents - already;
          amount = input.amountCents ?? open;
          if (amount <= 0 || (open <= 0 && input.amountCents === null)) throw new InvoiceError("Die Zuzahlung ist bereits vollständig quittiert.");
          if (amount > Math.max(0, open) && !input.confirmOverpay) {
            throw new InvoiceError(`Der Betrag liegt über der offenen Zuzahlung (${euro(Math.max(0, open))}) – Überzahlung bitte ausdrücklich bestätigen (Häkchen) oder den Betrag korrigieren.`);
          }
          // Obergrenze: Heilmittelkosten der Verordnung (Snapshot bzw. Schätzung)
          const limit = exp.snapshot.remedyCents > 0 ? exp.snapshot.remedyCents : EURO_INPUT_MAX_CENTS;
          if (already + amount > limit) throw new InvoiceError(`Betrag ist höher als die Heilmittelkosten der Verordnung (${euro(limit)}) – bitte prüfen.`);
        }

        const o = await loadOrg(tx, org);
        const label = `Zuzahlung zur Verordnung vom ${dateDe(vo.issuedAt)}${vo.doctorName ? ` (${vo.doctorName})` : ""}`;
        const lines = manual
          ? [{ description: "Zuzahlung laut Verordnung", cents: amount }]
          : copaymentReceiptLines(already ? null : exp.breakdown, amount, { prescriptionLabel: `Verordnung vom ${dateDe(vo.issuedAt)}`, positionLabel: (code) => positionInfo(code)?.label ?? null });
        const totals = computeTotals(lines.map((l) => ({ totalCents: l.cents, vatRate: 0 })));
        const expectedNote = manual ? "Betrag manuell, Berechnung nicht möglich (Preis bzw. Positionsnummer fehlt)." : copaymentExpectedNote(exp.breakdown, amount, already);
        const [draft] = await tx
          .insert(invoices)
          .values({
            organizationId: org,
            patientId: input.patientId,
            kind: "copayment",
            status: "draft",
            prescriptionId: vo.id,
            serviceDate: dates[0] ?? null,
            serviceDateTo: dates.length > 1 ? dates.at(-1)! : null,
            serviceDateFixed: true,
            notes: [`${label}.`, expectedNote].filter(Boolean).join("\n"),
            createdBy: auth.user.id,
          })
          .returning({ id: invoices.id });
        await tx.insert(invoiceLines).values(
          lines.map((l, i) => ({ organizationId: org, invoiceId: draft.id, description: l.description, quantity: "1", factor: "1", unitPriceCents: l.cents, vatRate: 0, totalCents: l.cents, position: i + 1 })),
        );
        const number = await nextNumber(tx, org, "copayment", Number(today.slice(0, 4)));
        await tx
          .update(invoices)
          .set({ number, status: "issued", issuedAt: today, dueAt: today, netCents: totals.netCents, vatCents: totals.vatCents, totalCents: totals.totalCents, issuedSnapshot: await issuedSnapshot(tx, org, o, input.patientId, null) })
          .where(and(eq(invoices.organizationId, org), eq(invoices.id, draft.id)));
        await applyPayments(
          tx,
          org,
          auth.user.id,
          { id: draft.id, number, totalCents: totals.totalCents, paidCents: 0 },
          [{ method: input.method, amountCents: totals.totalCents, voucherCode: null, externalRef: null, registerReceiptNo: input.registerReceiptNo ?? null }],
          today,
          totals.groups,
        );
        const archived = await archiveIssued(tx, org, draft.id, auth.user.id, pending);
        return { id: draft.id, number, amountCents: totals.totalCents, archived, expected: manual ? null : exp.breakdown.totalCents, already, estimated: exp.estimated, manual };
      }),
    );
    await reportInvoiceArchivePending(org, result);
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "prescription.copayment_receipt",
      entity: "prescription",
      entityId: input.prescriptionId,
      meta: { invoiceId: result.id, number: result.number, cents: result.amountCents, method: input.method, expectedCents: result.expected, estimated: result.estimated, manual: result.manual, overpayConfirmed: !!input.confirmOverpay },
    });
    return { id: result.id, number: result.number, amountCents: result.amountCents, warning: copaymentPaidHint(result.already + result.amountCents, result.expected) };
  } catch (e) {
    if (e instanceof InvoiceError) return { error: e.message };
    throw e;
  }
}

export const copaymentRefundInput = z.object({
  invoiceId: z.string().uuid(),
  patientId: z.string().uuid(),
  method: z.enum(COPAYMENT_RECEIPT_METHODS, { message: "Bitte die Zahlungsart der Erstattung wählen." }),
  registerReceiptNo: copaymentReceiptInput.shape.registerReceiptNo,
  reason: z.string().trim().min(5, "Bitte einen Grund angeben (mind. 5 Zeichen).").max(300),
});
export type CopaymentRefundInput = z.infer<typeof copaymentRefundInput>;

/**
 * Zuzahlungsquittung stornieren und den Betrag erstatten (negative Zahlung auf dem Stornobeleg, über denselben
 * Kassen-/TSE-Weg). Danach kann der richtige Betrag neu quittiert werden (Überzahlung, Tippfehler).
 */
export async function refundCopaymentReceipt(auth: AuthContext, raw: CopaymentRefundInput): Promise<{ error: string } | { creditNoteId: string; number: string; refundedCents: number; refundError: string | null }> {
  assertCan(auth, "invoices.write");
  const blocked = gkvGuard(auth.organization, "copayment");
  if (blocked) return blocked;
  const parsed = copaymentRefundInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const input = parsed.data;
  const org = auth.organization.id;
  const [inv] = await withOrg(org, (tx) =>
    tx
      .select({ kind: invoices.kind, status: invoices.status, patientId: invoices.patientId, prescriptionId: invoices.prescriptionId })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.id, input.invoiceId))),
  );
  if (!inv || inv.kind !== "copayment" || inv.patientId !== input.patientId) return { error: "Zuzahlungsquittung nicht gefunden." };
  if (inv.status === "cancelled") return { error: "Die Quittung ist bereits storniert." };
  try {
    const storno = await cancelInvoice(auth, input.invoiceId, `Erstattung der Zuzahlung: ${input.reason}`);
    let refundError: string | null = null;
    if (storno.refundCents > 0) {
      try {
        await addPayments(auth, storno.id, [{ method: input.method, amountCents: -storno.refundCents, voucherCode: null, externalRef: null, registerReceiptNo: input.registerReceiptNo ?? null }]);
      } catch (e) {
        // Storno steht; die Erstattung kann am Stornobeleg nachgetragen werden
        if (!(e instanceof InvoiceError)) throw e;
        refundError = e.message;
      }
    }
    await audit({ organizationId: org, userId: auth.user.id, action: "prescription.copayment_refund", entity: "prescription", entityId: inv.prescriptionId ?? undefined, meta: { invoiceId: input.invoiceId, creditNoteId: storno.id, cents: storno.refundCents, method: input.method, refundError: !!refundError } });
    return { creditNoteId: storno.id, number: storno.number, refundedCents: refundError ? 0 : storno.refundCents, refundError };
  } catch (e) {
    if (e instanceof InvoiceError) return { error: e.message };
    throw e;
  }
}
