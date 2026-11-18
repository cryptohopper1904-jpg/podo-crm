import "server-only";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { gkvDeductions, patients, prescriptionCorrections, prescriptions } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { NOTE_MIN } from "@/lib/rules/prescription";
import {
  APPROVAL_REF_PATTERN,
  CORRECTION_DERIVED_KEYS,
  CORRECTION_VOLATILE_KEYS,
  DEDUCTION_MAX_CENTS,
  DEDUCTION_OUTCOMES,
  DEDUCTION_STATUSES,
  PRESCRIPTION_KIND_CODES,
  PRESCRIPTION_SPECIAL_CODES,
  canChangeDeductionStatus,
  cleanText,
  isDeductionOutcome,
  isDeductionStatus,
  type DeductionOutcome,
  type DeductionStatus,
} from "@/lib/rules/gkv-billing";
import { assertCan } from "./authz";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (v: string) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// ───────────────────────── Abrechnungsangaben der Verordnung (8.1.11, 8.1.12, SKZ) ─────────────────────────

export const billingDetailsInput = z
  .object({
    id: z.string().uuid(),
    patientId: z.string().uuid(),
    /** Kennzeichen Verordnungsart – Pflicht (bewusste Auswahl = Bestätigung); „05“ wird nicht angenommen */
    prescriptionKind: z.enum(PRESCRIPTION_KIND_CODES as [string, ...string[]], { message: "Bitte das Kennzeichen Verordnungsart wählen (03 oder 04)." }),
    prescriptionSpecial: z.preprocess(emptyToUndef, z.enum(PRESCRIPTION_SPECIAL_CODES as [string, ...string[]], { message: "Verordnungsbesonderheit ungültig." }).optional()),
    approvalRef: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() || undefined : v),
      z.string().max(20, "Genehmigungskennzeichen: höchstens 20 Zeichen.").regex(APPROVAL_REF_PATTERN, "Genehmigungskennzeichen: nur Buchstaben, Ziffern, Punkt, Bindestrich, Schrägstrich.").optional(),
    ),
    approvalDate: z.preprocess(emptyToUndef, z.string().refine(realDate, "Datum der Genehmigung ungültig.").optional()),
  })
  .refine((d) => !!d.approvalRef === !!d.approvalDate, { message: "Genehmigung: Kennzeichen und Datum gehören zusammen." });
export type BillingDetailsInput = z.infer<typeof billingDetailsInput>;

/**
 * Kennzeichen Verordnungsart bestätigen sowie Verordnungsbesonderheit und Genehmigung (SKZ B2) erfassen. Bestätigt wird
 * immer durch die bewusste Auswahl (nie vorbelegt); gespeichert wird, wer und wann. Möglich, solange die Verordnung
 * nicht abgerechnet/storniert ist – auch nach Behandlungsbeginn (Genehmigung kommt oft später). Recht: medical.write.
 * Audit ohne Werte (das Kennzeichen „04“ ließe Rückschlüsse auf den Heilmittelbedarf zu) – der Stand steht an der Verordnung.
 */
export async function saveBillingDetails(auth: AuthContext, d: BillingDetailsInput): Promise<{ ok: true } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (d.approvalDate && d.approvalDate > today) return { error: "Das Datum der Genehmigung liegt in der Zukunft." };
  const res = await withOrg(org, async (tx) => {
    const [vo] = await tx
      .select({ status: prescriptions.status, kind: prescriptions.prescriptionKind, special: prescriptions.prescriptionSpecial, approvalRef: prescriptions.approvalRef, approvalDate: prescriptions.approvalDate })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id), eq(prescriptions.patientId, d.patientId)))
      .for("update");
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (vo.status === "billed") return { error: "Die Verordnung ist abgerechnet – Änderungen nur über „Korrektur nötig“." };
    if (vo.status === "cancelled") return { error: "Die Verordnung ist storniert." };
    const before = vo.status === "correction_needed" ? await prescriptionJson(tx, org, d.id) : null;
    const changed = {
      kind: vo.kind !== d.prescriptionKind,
      special: (vo.special ?? null) !== (d.prescriptionSpecial ?? null),
      approval: (vo.approvalRef ?? null) !== (d.approvalRef ?? null) || (vo.approvalDate ?? null) !== (d.approvalDate ?? null),
    };
    await tx
      .update(prescriptions)
      .set({
        prescriptionKind: d.prescriptionKind,
        prescriptionKindConfirmedAt: new Date(),
        prescriptionKindConfirmedBy: auth.user.id,
        prescriptionSpecial: d.prescriptionSpecial ?? null,
        approvalRef: d.approvalRef ?? null,
        approvalDate: d.approvalDate ?? null,
      })
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id)));
    // im Korrekturstatus: geänderte Feldnamen (ohne Werte) ins Audit
    const changedFields = before ? changedPrescriptionFields(before, await prescriptionJson(tx, org, d.id)) : undefined;
    return { ok: true as const, changed, firstConfirmation: !vo.kind, status: vo.status, changedFields };
  });
  if ("error" in res) return { error: res.error ?? "Fehler" };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.billing_details", entity: "prescription", entityId: d.id, meta: { ...res.changed, firstConfirmation: res.firstConfirmation, status: res.status, ...(res.changedFields ? { correction: true, changedFields: res.changedFields } : {}) } });
  return { ok: true };
}

// ───────────────────────── Absetzungen / Retaxen ─────────────────────────

/** Abrechnungsdaten mit Bezug zur Person → Rechnungen schreiben + medizinisch lesen (wie Abrechnungslauf) */
function billingAccess(auth: AuthContext): { error: string } | null {
  assertCan(auth, "invoices.write", "medical.read");
  return gkvGuard(auth.organization, "gkvBilling");
}

const euroCents = z.coerce.number().int("Betrag ungültig.").min(1, "Betrag muss größer als 0 sein.").max(DEDUCTION_MAX_CENTS, "Betrag über 10.000 € – bitte prüfen.");

export const deductionInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  amountCents: euroCents,
  reasonCode: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 40) || undefined : v), z.string().max(20, "Absetzungscode: höchstens 20 Zeichen.").optional()),
  reason: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 600) : v), z.string().min(3, "Bitte den Grund der Absetzung angeben.").max(500, "Grund: höchstens 500 Zeichen.")),
  deductedOn: z.string().refine(realDate, "Datum der Absetzung ungültig."),
  note: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 1200) || undefined : v), z.string().max(1000, "Notiz: höchstens 1000 Zeichen.").optional()),
  /** Aktenzeichen und Datum des Kassenschreibens (optional) */
  letterRef: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 80) || undefined : v), z.string().max(60, "Aktenzeichen: höchstens 60 Zeichen.").optional()),
  letterDate: z.preprocess(emptyToUndef, z.string().refine(realDate, "Datum des Kassenschreibens ungültig.").optional()),
});
export type DeductionInput = z.infer<typeof deductionInput>;

/** Absetzung zu einer abgerechneten Verordnung erfassen (Lauf aus der Verordnung). */
export async function createDeduction(auth: AuthContext, d: DeductionInput): Promise<{ id: string } | { error: string }> {
  const blocked = billingAccess(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (d.deductedOn > today) return { error: "Das Datum der Absetzung liegt in der Zukunft." };
  if (d.letterDate && d.letterDate > today) return { error: "Das Datum des Kassenschreibens liegt in der Zukunft." };
  const res = await withOrg(org, async (tx) => {
    const [vo] = await tx
      .select({ status: prescriptions.status, billedAt: prescriptions.billedAt, batch: prescriptions.billingBatchId })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId)));
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (!vo.billedAt && vo.status !== "billed" && vo.status !== "correction_needed") return { error: "Absetzungen gibt es nur zu abgerechneten Verordnungen." };
    const [row] = await tx
      .insert(gkvDeductions)
      .values({
        organizationId: org,
        prescriptionId: d.prescriptionId,
        patientId: d.patientId,
        billingBatchId: vo.batch ?? null,
        amountCents: d.amountCents,
        reasonCode: d.reasonCode ?? null,
        reason: d.reason,
        deductedOn: d.deductedOn,
        note: d.note ?? null,
        letterRef: d.letterRef ?? null,
        letterDate: d.letterDate ?? null,
        createdBy: auth.user.id,
      })
      .returning({ id: gkvDeductions.id });
    return { id: row.id };
  });
  if ("error" in res) return res as { error: string };
  // Audit ohne Grund/Notiz (können Gesundheitsangaben enthalten); Betrag und Code sind Abrechnungsdaten
  await audit({ organizationId: org, userId: auth.user.id, action: "gkv_deduction.create", entity: "gkv_deduction", entityId: res.id, meta: { prescriptionId: d.prescriptionId, amountCents: d.amountCents, reasonCode: d.reasonCode ?? null } });
  return res;
}

export const deductionUpdateInput = z.object({
  id: z.string().uuid(),
  status: z.enum(DEDUCTION_STATUSES),
  note: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 1200) : v), z.string().max(1000, "Notiz: höchstens 1000 Zeichen.").optional()),
  /** nur bei Status „offen“: Betrag korrigieren (Fehleingabe) */
  amountCents: z.preprocess(emptyToUndef, euroCents.optional()),
  /** Pflicht beim Wechsel auf „erledigt“: upheld = Absetzung bleibt | reversed = Widerspruch erfolgreich */
  outcome: z.preprocess(emptyToUndef, z.enum(DEDUCTION_OUTCOMES, { message: "Ausgang ungültig." }).optional()),
  /** Aktenzeichen/Datum des Kassenschreibens nachtragen (solange nicht erledigt); leer = unverändert */
  letterRef: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 80) || undefined : v), z.string().max(60, "Aktenzeichen: höchstens 60 Zeichen.").optional()),
  letterDate: z.preprocess(emptyToUndef, z.string().refine(realDate, "Datum des Kassenschreibens ungültig.").optional()),
});
export type DeductionUpdateInput = z.infer<typeof deductionUpdateInput>;

/** Status/Notiz einer Absetzung ändern; Betrag nur, solange offen (Trigger erzwingt dasselbe). */
export async function updateDeduction(auth: AuthContext, d: DeductionUpdateInput): Promise<{ ok: true } | { error: string }> {
  const blocked = billingAccess(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [old] = await tx.select().from(gkvDeductions).where(and(eq(gkvDeductions.organizationId, org), eq(gkvDeductions.id, d.id))).for("update");
    if (!old) return { error: "Absetzung nicht gefunden." };
    const from = isDeductionStatus(old.status) ? old.status : "open";
    if (from === "done") return { error: "Die Absetzung ist erledigt und abgeschlossen." };
    if (!canChangeDeductionStatus(from, d.status)) return { error: "Dieser Statuswechsel ist nicht möglich." };
    const amountChange = d.amountCents !== undefined && d.amountCents !== old.amountCents;
    if (amountChange && from !== "open") return { error: "Der Betrag ist nur bei offenen Absetzungen änderbar." };
    // „erledigt“ nur mit Ausgang (DB-CHECK gkv_deductions_outcome_check); sonst kein Ausgang
    if (d.status === "done" && !d.outcome) return { error: "Bitte den Ausgang angeben: Absetzung bleibt oder Widerspruch erfolgreich." };
    const note = d.note === undefined ? old.note : d.note || null;
    const letterRef = d.letterRef ?? old.letterRef;
    const letterDate = d.letterDate ?? old.letterDate;
    if (d.letterDate && d.letterDate > berlinDateIso()) return { error: "Das Datum des Kassenschreibens liegt in der Zukunft." };
    await tx
      .update(gkvDeductions)
      .set({ status: d.status, note, letterRef, letterDate, outcome: d.status === "done" ? d.outcome : null, ...(amountChange ? { amountCents: d.amountCents } : {}), updatedBy: auth.user.id, updatedAt: new Date() })
      .where(and(eq(gkvDeductions.organizationId, org), eq(gkvDeductions.id, d.id)));
    return {
      ok: true as const,
      from,
      amount: amountChange ? { from: old.amountCents, to: d.amountCents } : undefined,
      noteChanged: (old.note ?? null) !== note,
      letterChanged: (old.letterRef ?? null) !== (letterRef ?? null) || (old.letterDate ?? null) !== (letterDate ?? null),
    };
  });
  if ("error" in res) return { error: res.error ?? "Fehler" };
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "gkv_deduction.update",
    entity: "gkv_deduction",
    entityId: d.id,
    meta: { from: res.from, to: d.status, ...(d.status === "done" ? { outcome: d.outcome } : {}), ...(res.amount ? { amountCents: res.amount } : {}), noteChanged: res.noteChanged, letterChanged: res.letterChanged },
  });
  return { ok: true };
}

export type DeductionRow = {
  id: string;
  prescriptionId: string;
  patientId: string;
  patient: string;
  patientNumber: number;
  issuedAt: string;
  billingBatchId: string | null;
  amountCents: number;
  reasonCode: string | null;
  reason: string;
  deductedOn: string;
  status: DeductionStatus;
  outcome: DeductionOutcome | null;
  letterRef: string | null;
  letterDate: string | null;
  note: string | null;
  prescriptionStatus: string;
  createdAt: Date;
};

/** Absetzungen der Praxis (optional nach Status und Zeitraum des Absetzungsdatums), neueste zuerst, höchstens 500. */
export async function listDeductions(auth: AuthContext, filter: { statuses?: DeductionStatus[]; from?: string; to?: string } = {}): Promise<DeductionRow[] | { error: string }> {
  const blocked = billingAccess(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ d: gkvDeductions, p: { firstName: patients.firstName, lastName: patients.lastName, number: patients.number }, vo: { issuedAt: prescriptions.issuedAt, status: prescriptions.status } })
      .from(gkvDeductions)
      .innerJoin(patients, and(eq(patients.id, gkvDeductions.patientId), eq(patients.organizationId, org)))
      .innerJoin(prescriptions, and(eq(prescriptions.id, gkvDeductions.prescriptionId), eq(prescriptions.organizationId, org)))
      .where(
        and(
          eq(gkvDeductions.organizationId, org),
          filter.statuses?.length ? inArray(gkvDeductions.status, filter.statuses) : undefined,
          filter.from ? gte(gkvDeductions.deductedOn, filter.from) : undefined,
          filter.to ? lte(gkvDeductions.deductedOn, filter.to) : undefined,
        ),
      )
      .orderBy(desc(gkvDeductions.deductedOn), desc(gkvDeductions.createdAt))
      .limit(500),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "gkv_deduction.list", meta: { n: rows.length } });
  return rows.map(({ d, p, vo }) => ({
    id: d.id,
    prescriptionId: d.prescriptionId,
    patientId: d.patientId,
    patient: [p.firstName, p.lastName].filter(Boolean).join(" "),
    patientNumber: p.number,
    issuedAt: vo.issuedAt,
    billingBatchId: d.billingBatchId,
    amountCents: d.amountCents,
    reasonCode: d.reasonCode,
    reason: d.reason,
    deductedOn: d.deductedOn,
    status: isDeductionStatus(d.status) ? d.status : "open",
    outcome: isDeductionOutcome(d.outcome) ? d.outcome : null,
    letterRef: d.letterRef,
    letterDate: d.letterDate,
    note: d.note,
    prescriptionStatus: vo.status,
    createdAt: d.createdAt,
  }));
}

/** Absetzungen je Verordnung (Akte) */
export async function deductionsFor(tx: Tx, org: string, ids: string[]) {
  const map = new Map<string, (typeof gkvDeductions.$inferSelect)[]>();
  if (!ids.length) return map;
  const rows = await tx.select().from(gkvDeductions).where(and(eq(gkvDeductions.organizationId, org), inArray(gkvDeductions.prescriptionId, ids))).orderBy(asc(gkvDeductions.deductedOn), asc(gkvDeductions.createdAt));
  for (const r of rows) map.set(r.prescriptionId, [...(map.get(r.prescriptionId) ?? []), r]);
  return map;
}

// ───────────────────────── Korrektur abgerechneter Verordnungen ─────────────────────────

export type CorrectionRow = typeof prescriptionCorrections.$inferSelect;
type PrescriptionDbRow = typeof prescriptions.$inferSelect;

/** Verordnungszeile als jsonb (to_jsonb, wie original_row) – für Vergleich und Feldliste im Audit */
export async function prescriptionJson(tx: Tx, org: string, id: string): Promise<Record<string, unknown>> {
  const r = await tx.execute(sql`select to_jsonb(p) as j from prescriptions p where p.organization_id = ${org} and p.id = ${id}`);
  return ((r.rows[0] as { j?: Record<string, unknown> } | undefined)?.j ?? {}) as Record<string, unknown>;
}

/** Namen der geänderten Spalten (keine Werte – können Gesundheitsangaben enthalten), sortiert */
export function changedPrescriptionFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}

/**
 * original_row (to_jsonb der Verordnungszeile, Spaltennamen) → Drizzle-Zeile (Feldnamen, Zeitstempel als Date). Für den
 * Export des alten Laufs (CSV, § 302) mit dem Stand der Erstabrechnung.
 */
export function prescriptionFromOriginalRow(j: Record<string, unknown>): PrescriptionDbRow {
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(prescriptions))) {
    const v = j[col.name];
    out[key] = v === undefined ? null : col.dataType === "date" && typeof v === "string" ? new Date(v) : v;
  }
  return out as PrescriptionDbRow;
}

/** SQL-Liste der beim Vergleich mit original_row ausgenommenen Schlüssel (feste Konstanten, kein Nutzereingang) */
const keysSql = (keys: readonly string[]) => sql.raw(`ARRAY[${keys.map((k) => `'${k.replace(/'/g, "")}'`).join(", ")}]::text[]`);

/** Korrekturvermerke je Verordnung (neueste zuletzt) */
export async function correctionsFor(tx: Tx, org: string, ids: string[]) {
  const map = new Map<string, CorrectionRow[]>();
  if (!ids.length) return map;
  const rows = await tx.select().from(prescriptionCorrections).where(and(eq(prescriptionCorrections.organizationId, org), inArray(prescriptionCorrections.prescriptionId, ids))).orderBy(asc(prescriptionCorrections.createdAt));
  for (const r of rows) map.set(r.prescriptionId, [...(map.get(r.prescriptionId) ?? []), r]);
  return map;
}

export const correctionInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  reason: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 600) : v), z.string().min(NOTE_MIN, "Bitte begründen, was korrigiert werden muss (mind. 5 Zeichen).").max(500, "Begründung: höchstens 500 Zeichen.")),
  deductionId: z.preprocess(emptyToUndef, z.string().uuid().optional()),
});
export type CorrectionInput = z.infer<typeof correctionInput>;

/**
 * „Korrektur nötig“: abgerechnete Verordnung wieder bearbeitbar machen – nur mit Begründung und Korrekturvermerk, der
 * den Stand der Erstabrechnung (Lauf, Zeitpunkt, Beträge, Preis-Snapshot) festhält. Der DB-Trigger erlaubt aus
 * „abgerechnet“ nur diesen Wechsel und nur mit offenem Vermerk. Danach: korrigieren, „abrechnungsreif“ setzen und im
 * nächsten Abrechnungslauf erneut abrechnen (der Vermerk wird dann als „erneut abgerechnet“ abgeschlossen).
 */
export async function markCorrectionNeeded(auth: AuthContext, d: CorrectionInput): Promise<{ id: string } | { error: string }> {
  const blocked = billingAccess(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [vo] = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId))).for("update");
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (vo.status !== "billed") return { error: "„Korrektur nötig“ gibt es nur für abgerechnete Verordnungen." };
    if (d.deductionId) {
      const [ded] = await tx.select({ id: gkvDeductions.id }).from(gkvDeductions).where(and(eq(gkvDeductions.organizationId, org), eq(gkvDeductions.id, d.deductionId), eq(gkvDeductions.prescriptionId, vo.id)));
      if (!ded) return { error: "Die Absetzung gehört nicht zu dieser Verordnung." };
    }
    const [c] = await tx
      .insert(prescriptionCorrections)
      .values({
        organizationId: org,
        prescriptionId: vo.id,
        patientId: vo.patientId,
        deductionId: d.deductionId ?? null,
        reason: d.reason,
        originalBatchId: vo.billingBatchId,
        originalBilledAt: vo.billedAt,
        originalRemedyCostCents: vo.remedyCostCents,
        originalCopaymentCents: vo.copaymentCents,
        originalPriceSnapshot: vo.priceSnapshot,
        createdBy: auth.user.id,
      })
      .returning({ id: prescriptionCorrections.id });
    await tx.update(prescriptions).set({ status: "correction_needed" }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, vo.id)));
    return { id: c.id, batch: vo.billingBatchId };
  });
  if ("error" in res) return { error: res.error ?? "Fehler" };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.correction_needed", entity: "prescription", entityId: d.prescriptionId, meta: { correctionId: res.id, originalBatchId: res.batch, deductionId: d.deductionId ?? null } });
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.status", entity: "prescription", entityId: d.prescriptionId, meta: { from: "billed", to: "correction_needed", correctionId: res.id } });
  return { id: res.id };
}

export const resolveCorrectionInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  note: z.preprocess((v) => (typeof v === "string" ? cleanText(v, 600) : v), z.string().min(NOTE_MIN, "Bitte begründen (mind. 5 Zeichen), z. B. „Absetzung akzeptiert, keine Neuabrechnung“.").max(500)),
});

/**
 * Korrektur ohne Neuabrechnung abschließen (z. B. Absetzung akzeptiert): Status zurück auf „abgerechnet“ (Lauf und
 * Zeitpunkt der Erstabrechnung bleiben), Vermerk „ohne Neuabrechnung“. Nur aus „Korrektur nötig“.
 */
export async function resolveCorrectionWithoutRebill(auth: AuthContext, d: z.infer<typeof resolveCorrectionInput>): Promise<{ ok: true } | { error: string }> {
  const blocked = billingAccess(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [vo] = await tx.select({ id: prescriptions.id, status: prescriptions.status }).from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId))).for("update");
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (vo.status !== "correction_needed") return { error: "Die Verordnung ist nicht im Status „Korrektur nötig“ – bitte Seite neu laden." };
    // Nur unverändert zurück in den alten Lauf: Inhalt gegen den Stand der Erstabrechnung (original_row), ohne Status,
    // Altvermerk Zuzahlung, Bestätigungszeitpunkt und abgeleitete Beträge (die werden unten wiederhergestellt)
    const cmp = await tx.execute(sql`
      select c.id, c.original_row is null as missing,
             (to_jsonb(p) - ${keysSql(CORRECTION_VOLATILE_KEYS)} - ${keysSql(CORRECTION_DERIVED_KEYS)})
               = (c.original_row - ${keysSql(CORRECTION_VOLATILE_KEYS)} - ${keysSql(CORRECTION_DERIVED_KEYS)}) as same
        from prescription_corrections c join prescriptions p on p.id = c.prescription_id and p.organization_id = c.organization_id
       where c.organization_id = ${org} and c.prescription_id = ${vo.id} and c.resolved_at is null`);
    const open = cmp.rows[0] as { id: string; missing: boolean; same: boolean | null } | undefined;
    if (!open) return { error: "Kein offener Korrekturvermerk gefunden." };
    if (open.missing || !open.same) return { error: "Geänderte Verordnung muss neu abgerechnet werden." };
    // resolved_at = now(): der DB-Trigger erkennt so den Abschluss im selben Vorgang
    const done = await tx
      .update(prescriptionCorrections)
      .set({ resolution: "no_rebill", resolvedAt: sql`now()`, resolvedBy: auth.user.id, resolutionNote: d.note })
      .where(and(eq(prescriptionCorrections.organizationId, org), eq(prescriptionCorrections.id, open.id), isNull(prescriptionCorrections.resolvedAt)))
      .returning({ id: prescriptionCorrections.id });
    if (!done.length) return { error: "Kein offener Korrekturvermerk gefunden." };
    // Preis-Snapshot, Heilmittelkosten und Zuzahlung der Erstabrechnung wiederherstellen (ein zwischenzeitlich neu
    // berechneter Snapshot aus „abrechnungsreif“ gilt nicht – die Verordnung bleibt im alten Lauf)
    await tx.execute(sql`
      update prescriptions p
         set status = 'billed',
             price_snapshot = c.original_row->'price_snapshot',
             remedy_cost_cents = (c.original_row->>'remedy_cost_cents')::int,
             copayment_cents = (c.original_row->>'copayment_cents')::int
        from prescription_corrections c
       where c.id = ${open.id} and c.organization_id = ${org} and p.id = c.prescription_id and p.organization_id = ${org}`);
    return { ok: true as const, correctionId: done[0].id };
  });
  if ("error" in res) return { error: res.error ?? "Fehler" };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.correction_resolved", entity: "prescription", entityId: d.prescriptionId, meta: { correctionId: res.correctionId, resolution: "no_rebill" } });
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.status", entity: "prescription", entityId: d.prescriptionId, meta: { from: "correction_needed", to: "billed", correctionId: res.correctionId } });
  return { ok: true };
}

/**
 * Im Abrechnungslauf aufgerufen (createBillingBatch, gleiche Transaktion): offene Korrekturvermerke der erneut
 * abgerechneten Verordnungen als „erneut abgerechnet“ in diesem Lauf abschließen. Gibt die Anzahl zurück.
 */
export async function resolveCorrectionsRebilled(tx: Tx, org: string, userId: string, prescriptionIds: string[], batchId: string): Promise<number> {
  if (!prescriptionIds.length) return 0;
  const done = await tx
    .update(prescriptionCorrections)
    .set({ resolution: "rebilled", resolvedAt: new Date(), resolvedBy: userId, resolvedBatchId: batchId })
    .where(and(eq(prescriptionCorrections.organizationId, org), inArray(prescriptionCorrections.prescriptionId, prescriptionIds), isNull(prescriptionCorrections.resolvedAt)))
    .returning({ id: prescriptionCorrections.id });
  return done.length;
}

/**
 * Verordnungen, die ursprünglich in diesem Lauf abgerechnet und danach zur Korrektur geöffnet wurden (Export des alten
 * Laufs): je Verordnung der Stand der Erstabrechnung aus dem ältesten Korrekturvermerk dieses Laufs (original_row). Der
 * alte Lauf wird damit reproduzierbar exportiert (Zeilensumme = Laufsumme), egal ob die Korrektur offen, ohne
 * Neuabrechnung abgeschlossen oder in einem späteren Lauf neu abgerechnet ist.
 */
export async function correctedFromBatch(tx: Tx, org: string, batchId: string): Promise<Map<string, PrescriptionDbRow | null>> {
  const rows = await tx
    .select({ id: prescriptionCorrections.prescriptionId, row: prescriptionCorrections.originalRow })
    .from(prescriptionCorrections)
    .where(and(eq(prescriptionCorrections.organizationId, org), eq(prescriptionCorrections.originalBatchId, batchId)))
    .orderBy(asc(prescriptionCorrections.createdAt), asc(prescriptionCorrections.id));
  const out = new Map<string, PrescriptionDbRow | null>();
  for (const r of rows) if (!out.has(r.id)) out.set(r.id, r.row ? prescriptionFromOriginalRow(r.row) : null);
  return out;
}

/** Anzahl offener Korrekturen der Praxis (Hinweis auf der Abrechnungsseite) */
export async function openCorrectionCount(tx: Tx, org: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(prescriptionCorrections).where(and(eq(prescriptionCorrections.organizationId, org), isNull(prescriptionCorrections.resolvedAt)));
  return Number(r?.n ?? 0);
}
