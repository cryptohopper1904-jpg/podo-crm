import "server-only";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { billingBatches, media, patients, prescriptions, services, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "./authz";
import { neutralizeCsvRows } from "@/lib/csv-safe";
import { parseImportData } from "@/integrations/ocr/schema";
import type { AuthContext } from "@/lib/auth/session";
import { ageYears, berlinDateIso, dateDe } from "@/lib/format";
import {
  DIAGNOSIS_GROUP_CODES,
  RULES_VERSION,
  canTransition,
  copaymentCents,
  evaluatePrescription,
  remedyCostCents,
  startDeadline,
  validatePrescription,
  type PrescriptionStatus,
} from "@/lib/rules/prescription";

export type PrescriptionRow = typeof prescriptions.$inferSelect;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max = 200) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const checkbox = z.preprocess((v) => v === "on" || v === "1" || v === true, z.boolean());

export const prescriptionInput = z.object({
  id: z.preprocess(emptyToUndef, z.string().uuid().optional()),
  patientId: z.string().uuid(),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ausstellungsdatum fehlt."),
  doctorName: optText(),
  doctorLanr: z.preprocess(emptyToUndef, z.string().trim().regex(/^\d{9}$/, "LANR hat 9 Ziffern.").optional()),
  doctorBsnr: z.preprocess(emptyToUndef, z.string().trim().regex(/^\d{9}$/, "BSNR hat 9 Ziffern.").optional()),
  diagnosisGroup: z.enum(DIAGNOSIS_GROUP_CODES as [string, ...string[]], { message: "Bitte eine Diagnosegruppe wählen." }),
  icd10: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() || undefined : v), z.string().max(20).optional()),
  remedy: optText(300),
  units: z.coerce.number().int().min(1, "Bitte die verordneten Einheiten angeben.").max(99),
  frequencyPerWeek: optText(80),
  homeVisit: checkbox,
  urgent: checkbox,
  copaymentExempt: checkbox,
  therapyReportRequested: checkbox,
  scanMediaId: z.preprocess(emptyToUndef, z.string().uuid().optional()),
  /** „ocr“ nur zusammen mit gültiger importData (Vorschlag + Sicherheit, nie Bilddaten) */
  source: z.preprocess(emptyToUndef, z.enum(["paper", "ocr"]).default("paper")),
  importData: z.preprocess(emptyToUndef, z.string().max(20_000).optional()),
  positions: z.preprocess(
    (v) => {
      try {
        return JSON.parse(String(v ?? "[]"));
      } catch {
        return null;
      }
    },
    z.array(z.object({ position: z.string().trim().max(20).optional(), label: z.string().trim().max(200), units: z.coerce.number().int() })).max(10, "Höchstens 10 Positionen."),
  ),
});
export type PrescriptionInput = z.infer<typeof prescriptionInput>;

/** Behandlungstage je Verordnung (Berliner Datum), aufsteigend */
async function usageFor(tx: Tx, org: string, ids: string[]) {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const rows = await tx
    .select({ prescriptionId: treatmentRecords.prescriptionId, treatedAt: treatmentRecords.treatedAt })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.prescriptionId, ids)))
    .orderBy(asc(treatmentRecords.treatedAt));
  for (const r of rows) {
    if (!r.prescriptionId) continue;
    const list = map.get(r.prescriptionId) ?? [];
    list.push(berlinDateIso(r.treatedAt));
    map.set(r.prescriptionId, list);
  }
  return map;
}

function evaluate(vo: PrescriptionRow, dates: string[], today = berlinDateIso()) {
  return evaluatePrescription({
    issuedAt: vo.issuedAt,
    urgent: vo.urgent,
    units: vo.units,
    status: vo.status,
    frequency: vo.frequencyPerWeek,
    treatmentDates: dates,
    today,
    startBy: vo.startBy,
  });
}

/** Entfernt medizinische Details (für Rollen ohne medical.read). */
export function redact(vo: PrescriptionRow): PrescriptionRow {
  return { ...vo, diagnosisGroup: "", icd10: null, remedy: null, positions: [], doctorName: null, doctorLanr: null, doctorBsnr: null, interruptionNote: null, scanMediaId: null };
}

export function prescriptionLabel(vo: Pick<PrescriptionRow, "diagnosisGroup" | "issuedAt" | "units">, remaining: number) {
  return `${vo.diagnosisGroup} vom ${dateDe(vo.issuedAt)} · noch ${remaining} von ${vo.units} Einheiten`;
}

export async function listPatientPrescriptions(auth: AuthContext, patientId: string) {
  assertCan(auth, "medical.read");
  const org = auth.organization.id;
  const result = await withOrg(org, async (tx) => {
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const rows = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.patientId, patientId))).orderBy(desc(prescriptions.issuedAt), desc(prescriptions.createdAt));
    const usage = await usageFor(tx, org, rows.map((r) => r.id));
    return { patient: p, prescriptions: rows.map((r) => ({ ...r, dates: usage.get(r.id) ?? [], evaluation: evaluate(r, usage.get(r.id) ?? []) })) };
  });
  if (result) await audit({ organizationId: org, userId: auth.user.id, action: "prescriptions.read", entity: "patient", entityId: patientId });
  return result;
}

/** Für die Doku: Verordnungen des Patienten, auf die noch Einheiten gebucht werden können. */
export async function bookablePrescriptions(tx: Tx, org: string, patientId: string) {
  const rows = await tx
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.patientId, patientId), inArray(prescriptions.status, ["open", "active"])))
    .orderBy(asc(prescriptions.issuedAt));
  const usage = await usageFor(tx, org, rows.map((r) => r.id));
  return rows
    .map((r) => {
      const ev = evaluate(r, usage.get(r.id) ?? []);
      return { id: r.id, label: prescriptionLabel(r, ev.unitsRemaining), remaining: ev.unitsRemaining, warning: ev.messages[0] ?? null };
    })
    .filter((r) => r.remaining > 0);
}

/** Übersicht aller laufenden Verordnungen der Praxis (Ampel). */
export async function listRunningPrescriptions(auth: AuthContext, statuses: PrescriptionStatus[] = ["open", "active", "completed", "billing_ready"]) {
  assertCan(auth, "patients.read");
  const medical = auth.can("medical.read");
  const org = auth.organization.id;
  const rows = await withOrg(org, async (tx) => {
    const list = await tx
      .select({ vo: prescriptions, p: { id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, title: patients.title, salutation: patients.salutation, insurerName: patients.insurerName } })
      .from(prescriptions)
      .innerJoin(patients, eq(patients.id, prescriptions.patientId))
      .where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.status, statuses)))
      .orderBy(asc(prescriptions.startBy), asc(prescriptions.issuedAt));
    const usage = await usageFor(tx, org, list.map((r) => r.vo.id));
    // Ohne medizinisches Leserecht (Empfang): nur Fristen/Einheiten, keine Diagnose-/Arztdetails
    return list.map((r) => ({ ...r, vo: medical ? r.vo : redact(r.vo), evaluation: evaluate(r.vo, usage.get(r.vo.id) ?? []) }));
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "prescriptions.list", meta: { n: rows.length } });
  return rows;
}

/** Legt eine Verordnung an oder ändert sie (nur solange noch keine Einheit erbracht wurde). */
/** Herkunft beim Anlegen aus einem Import (eVerordnung) – nur beim Neuanlegen, Bearbeitungen behalten die Herkunft. */
export type PrescriptionOrigin = { source: "everordnung"; externalRef: string; importData: Record<string, unknown> };

/**
 * `opts.tx`: in einer bestehenden Transaktion des Aufrufers speichern (z. B. eVerordnung-Import zusammen mit
 * der Patientenanlage). Dann schreibt diese Funktion KEIN Audit – der Aufrufer ruft nach dem Commit
 * `afterCommit()` auf. Ohne `tx`: eigene Transaktion, Audit nach dem Commit (wie bisher).
 */
export async function savePrescription(
  auth: AuthContext,
  d: PrescriptionInput,
  opts: { origin?: PrescriptionOrigin; tx?: Tx } = {},
): Promise<{ id: string; warnings: string[]; afterCommit?: () => Promise<void> } | { error: string }> {
  assertCan(auth, "medical.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  const positions = d.positions.map((p) => ({ ...(p.position ? { position: p.position } : {}), label: p.label, units: p.units })).filter((p) => p.label || p.position);
  const check = validatePrescription({ issuedAt: d.issuedAt, diagnosisGroup: d.diagnosisGroup, units: d.units, positions, icd10: d.icd10, today });
  if (check.errors.length) return { error: check.errors[0] };

  const ocr = d.source === "ocr" ? parseImportData(d.importData) : null;
  if (d.source === "ocr" && !ocr) return { error: "Die ausgelesenen Daten sind ungültig – bitte erneut auslesen oder manuell erfassen." };
  if (ocr && !d.scanMediaId) return { error: "Zur Auslesung gehört das Foto der Verordnung." };

  const run = async (tx: Tx): Promise<{ error: string } | { id: string; warnings: string[]; created: boolean }> => {
    const [p] = await tx.select({ id: patients.id, birthDate: patients.birthDate }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId)));
    if (!p) return { error: "Kunde nicht gefunden." };
    if (d.scanMediaId) {
      const [m] = await tx.select({ id: media.id }).from(media).where(and(eq(media.organizationId, org), eq(media.id, d.scanMediaId), eq(media.patientId, d.patientId), eq(media.purpose, "prescription")));
      if (!m) return { error: "Das Foto der Verordnung gehört nicht zu diesem Kunden." };
    }
    // Zuzahlung aus den Preisen des Leistungskatalogs (Feld „GKV-Position“)
    const codes = positions.map((x) => x.position).filter((x): x is string => !!x);
    const priced = codes.length
      ? await tx.select({ gkvPosition: services.gkvPosition, priceCents: services.priceCents }).from(services).where(and(eq(services.organizationId, org), inArray(services.gkvPosition, codes), isNotNull(services.gkvPosition)))
      : [];
    const price = new Map(priced.map((s) => [s.gkvPosition, s.priceCents]));
    const cost = remedyCostCents(positions.map((x) => ({ units: x.units, priceCents: x.position ? price.get(x.position) : null })));
    const warnings = [...check.warnings];
    if (!cost.complete && !d.copaymentExempt) warnings.push("Für mindestens eine Position fehlt der Preis im Leistungskatalog (GKV-Position) – Zuzahlung bitte prüfen.");
    const values = {
      issuedAt: d.issuedAt,
      doctorName: d.doctorName ?? null,
      doctorLanr: d.doctorLanr ?? null,
      doctorBsnr: d.doctorBsnr ?? null,
      diagnosisGroup: d.diagnosisGroup,
      icd10: d.icd10 ?? null,
      remedy: d.remedy ?? null,
      units: d.units,
      frequencyPerWeek: d.frequencyPerWeek ?? null,
      homeVisit: d.homeVisit,
      urgent: d.urgent,
      copaymentExempt: d.copaymentExempt,
      therapyReportRequested: d.therapyReportRequested,
      positions,
      startBy: startDeadline(d.issuedAt, d.urgent),
      copaymentCents: copaymentCents(cost.cents, { exempt: d.copaymentExempt, ageYears: ageYears(p.birthDate) }),
      rulesVersion: RULES_VERSION,
      ...(d.scanMediaId ? { scanMediaId: d.scanMediaId } : {}),
      ...(ocr ? { source: "ocr", importData: ocr } : {}),
    };
    if (d.id) {
      const [old] = await tx.select({ status: prescriptions.status }).from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id), eq(prescriptions.patientId, d.patientId)));
      if (!old) return { error: "Verordnung nicht gefunden." };
      const used = (await usageFor(tx, org, [d.id])).get(d.id)?.length ?? 0;
      if (old.status !== "open" || used > 0) return { error: "Nach der ersten Behandlung ist die Verordnung nicht mehr änderbar." };
      await tx.update(prescriptions).set(values).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id)));
      return { id: d.id, warnings, created: false };
    }
    const [row] = await tx
      .insert(prescriptions)
      .values({ ...values, ...(opts.origin ?? {}), organizationId: org, patientId: d.patientId, status: "open", createdBy: auth.user.id })
      .returning({ id: prescriptions.id });
    return { id: row.id, warnings, created: true };
  };
  const result = opts.tx ? await run(opts.tx) : await withOrg(org, run);
  if ("error" in result) return { error: result.error };
  const writeAudit = () =>
    audit({ organizationId: org, userId: auth.user.id, action: result.created ? "prescription.create" : "prescription.update", entity: "prescription", entityId: result.id, meta: { patientId: d.patientId, rulesVersion: RULES_VERSION, source: ocr ? "ocr" : undefined, edited: ocr?.edited } });
  if (opts.tx) return { id: result.id, warnings: result.warnings, afterCommit: writeAudit };
  await writeAudit();
  return { id: result.id, warnings: result.warnings };
}

export async function changePrescriptionStatus(
  auth: AuthContext,
  input: { id: string; patientId: string; to: PrescriptionStatus; interruptionNote?: string | null },
): Promise<{ ok: true } | { error: string }> {
  assertCan(auth, "medical.write");
  const org = auth.organization.id;
  const result = await withOrg(org, async (tx) => {
    const [vo] = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.id), eq(prescriptions.patientId, input.patientId))).for("update");
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (input.to === "billed") return { error: "„Abgerechnet“ wird nur über einen Abrechnungslauf gesetzt." };
    const used = (await usageFor(tx, org, [vo.id])).get(vo.id)?.length ?? 0;
    const note = input.interruptionNote?.trim() || vo.interruptionNote;
    const t = canTransition(vo.status as PrescriptionStatus, input.to, { unitsUsed: used, units: vo.units, interruptionNote: note });
    if (!t.ok) return { error: t.reason };
    await tx.update(prescriptions).set({ status: input.to, interruptionNote: note ?? null }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, vo.id)));
    return { ok: true as const, from: vo.status };
  });
  if ("error" in result) return { error: result.error ?? "Fehler" };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.status", entity: "prescription", entityId: input.id, meta: { from: result.from, to: input.to } });
  return { ok: true };
}

export async function setCopaymentPaid(auth: AuthContext, input: { id: string; patientId: string; paid: boolean }) {
  assertCan(auth, "medical.write");
  const org = auth.organization.id;
  await withOrg(org, (tx) =>
    tx.update(prescriptions).set({ copaymentPaidAt: input.paid ? new Date() : null }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.id), eq(prescriptions.patientId, input.patientId))),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.copayment", entity: "prescription", entityId: input.id, meta: { paid: input.paid } });
}

// ───────────────────────── Abrechnungslauf ─────────────────────────

export async function listBillingBatches(auth: AuthContext) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  return withOrg(org, (tx) => tx.select().from(billingBatches).where(eq(billingBatches.organizationId, org)).orderBy(desc(billingBatches.createdAt)).limit(50));
}

/** Erstellt einen Abrechnungslauf aus abrechnungsreifen Verordnungen und markiert sie als abgerechnet. */
export async function createBillingBatch(auth: AuthContext, ids: string[], opts: { partner: string; note?: string | null }): Promise<{ id: string; count: number } | { error: string }> {
  assertCan(auth, "invoices.write", "medical.read");
  const org = auth.organization.id;
  if (!ids.length) return { error: "Bitte mindestens eine Verordnung auswählen." };
  const result = await withOrg(org, async (tx) => {
    const rows = await tx
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.id, ids), eq(prescriptions.status, "billing_ready")))
      .for("update");
    if (rows.length !== ids.length) return { error: "Einige Verordnungen sind nicht (mehr) abrechnungsreif. Bitte Seite neu laden." };
    const total = rows.reduce((s, r) => s + (r.copaymentCents ?? 0), 0);
    const [batch] = await tx
      .insert(billingBatches)
      .values({ organizationId: org, createdBy: auth.user.id, partner: opts.partner, status: "draft", prescriptionCount: rows.length, totalCents: total, note: opts.note ?? null })
      .returning({ id: billingBatches.id });
    const now = new Date();
    await tx.update(prescriptions).set({ status: "billed", billedAt: now, billingBatchId: batch.id }).where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.id, ids)));
    return { id: batch.id, count: rows.length };
  });
  if ("error" in result) return result;
  await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.create", entity: "billing_batch", entityId: result.id, meta: { count: result.count, partner: opts.partner } });
  return result;
}

export const GKV_BATCH_HEADER = [
  "Lauf-ID",
  "Verordnung-ID",
  "Versichertennummer",
  "Krankenkasse",
  "Nachname",
  "Vorname",
  "Geburtsdatum",
  "Arzt",
  "LANR",
  "BSNR",
  "Ausstellungsdatum",
  "Diagnosegruppe",
  "ICD-10",
  "Heilmittel",
  "Hausbesuch",
  "Dringlich",
  "Verordnete Einheiten",
  "Erbrachte Einheiten",
  "Positionen (Nr:Bezeichnung:Einheiten)",
  "Behandlungstage",
  "Zuzahlung EUR",
  "Zuzahlungsbefreit",
  "Zuzahlung erhalten am",
  "Therapiebericht angefordert",
  "Abbruch-/Unterbrechungsvermerk",
  "Regelwerk",
];

/** Zeilen für den neutralen CSV-Export eines Abrechnungslaufs (Übergabe an ein Abrechnungszentrum). */
export async function billingBatchExport(auth: AuthContext, batchId: string) {
  // enthält Diagnosen (ICD-10) → zusätzlich medizinisches Leserecht
  assertCan(auth, "invoices.write", "medical.read");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [batch] = await tx.select().from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    if (!batch) return null;
    const rows = await tx
      .select({ vo: prescriptions, p: patients })
      .from(prescriptions)
      .innerJoin(patients, eq(patients.id, prescriptions.patientId))
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.billingBatchId, batchId)))
      .orderBy(asc(patients.lastName), asc(prescriptions.issuedAt));
    const usage = await usageFor(tx, org, rows.map((r) => r.vo.id));
    if (!batch.exportedAt) {
      await tx.update(billingBatches).set({ exportedAt: new Date(), status: "exported" }).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    }
    return { batch, rows, usage };
  });
  if (!data) return null;
  const euro = (c: number | null) => ((c ?? 0) / 100).toFixed(2).replace(".", ",");
  const lines: unknown[][] = [GKV_BATCH_HEADER];
  for (const { vo, p } of data.rows) {
    const dates = data.usage.get(vo.id) ?? [];
    lines.push([
      data.batch.id,
      vo.id,
      p.insuranceNumber ?? "",
      p.insurerName ?? "",
      p.lastName,
      p.firstName ?? "",
      p.birthDate ?? "",
      vo.doctorName ?? "",
      vo.doctorLanr ?? "",
      vo.doctorBsnr ?? "",
      vo.issuedAt,
      vo.diagnosisGroup,
      vo.icd10 ?? "",
      vo.remedy ?? "",
      vo.homeVisit ? "ja" : "nein",
      vo.urgent ? "ja" : "nein",
      vo.units,
      dates.length,
      vo.positions.map((x) => `${x.position ?? ""}:${x.label}:${x.units}`).join(" | "),
      dates.join(" | "),
      euro(vo.copaymentCents),
      vo.copaymentExempt ? "ja" : "nein",
      vo.copaymentPaidAt ? berlinDateIso(vo.copaymentPaidAt) : "",
      vo.therapyReportRequested ? "ja" : "nein",
      vo.interruptionNote ?? "",
      vo.rulesVersion ?? "",
    ]);
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.export", entity: "billing_batch", entityId: batchId, meta: { count: data.rows.length } });
  // Formel-Injection verhindern (Namen, Arzt, Freitexte stammen aus Eingaben)
  return { batch: data.batch, lines: neutralizeCsvRows(lines) };
}
