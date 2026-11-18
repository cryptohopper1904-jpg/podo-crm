import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { billingBatches, media, organizations, patients, prescriptionCorrections, prescriptions, services, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "./authz";
import { gkvGuard } from "@/lib/features";
import { neutralizeCsvRows } from "@/lib/csv-safe";
import { parseImportData } from "@/integrations/ocr/schema";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, dateDe } from "@/lib/format";
import {
  DIAGNOSIS_GROUP_CODES,
  DIAGNOSIS_GROUPS,
  NOTE_MIN,
  RULES_VERSION,
  addDaysIso,
  anlage3Findings,
  autoExpiryApplies,
  blocksBilling,
  canTransition,
  evaluatePrescription,
  exemptOn,
  exemptionSummary,
  frequencyDeviation,
  frequencyDeviationText,
  hasAnlage3Fields,
  preparePositions,
  priceSnapshot,
  remedyCostCents,
  startDeadline,
  validatePrescription,
  type DiagnosisGroup,
  type Finding,
  type FrequencyDeviation,
  type PrescriptionStatus,
  type PriceSnapshot,
} from "@/lib/rules/prescription";
import { INSURED_STATUS, normalizeId } from "@/lib/rules/gkv-ids";
import { collectedCents, copaymentDue, copaymentReceiptsFor, legacyCopayment, type CopaymentReceiptRow } from "./copayments";
import { missingSignatureCounts, signatureRequired } from "./signatures";
import { reportOrdered, reportsFor, therapyReportDate } from "./therapy-reports";
import { followUpForPatient } from "./follow-ups";
import { changedPrescriptionFields, correctedFromBatch, correctionsFor, deductionsFor, prescriptionJson, resolveCorrectionsRebilled } from "./gkv-billing";
import { KIND_MISSING, PRESCRIPTION_SPECIALS, rebillCopaymentHint, suggestPrescriptionKind, type PrescriptionSpecial } from "@/lib/rules/gkv-billing";
import { priceFor } from "@/lib/rules/podologie-verguetung";

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
  /** zweiter ICD-10-Schlüssel, Klartext-Diagnose, Leitsymptomatik (Anlage 3 Buchst. k, l) */
  icd10Second: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() || undefined : v), z.string().max(20).optional()),
  diagnosisText: optText(300),
  leitsymptomatik: z.preprocess(emptyToUndef, z.enum(["a", "b", "c", "x"], { message: "Leitsymptomatik ungültig." }).optional()),
  leitsymptomatikText: optText(300),
  /** Personalienfeld der Verordnung (Anlage 3 Buchst. a) */
  insurerIk: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s+/g, "") || undefined : v), z.string().regex(/^\d{9}$/, "IK der Krankenkasse hat 9 Ziffern.").optional()),
  insuranceNumber: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() || undefined : v), z.string().max(12, "Versichertennummer zu lang.").optional()),
  insuredStatus: z.preprocess(emptyToUndef, z.enum(Object.keys(INSURED_STATUS) as [string, ...string[]], { message: "Versichertenstatus: 1, 3 oder 5." }).optional()),
  accident: checkbox,
  bvg: checkbox,
  /** Arztstempel + Unterschrift (Anlage 3 Buchst. n): angehakt = ja; mit doctorSignedAsked und ohne Haken = nein */
  doctorSigned: checkbox,
  doctorSignedAsked: checkbox,
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

export function evaluate(vo: Pick<PrescriptionRow, "issuedAt" | "urgent" | "units" | "status" | "frequencyPerWeek" | "startBy" | "reopenedAt" | "rulesVersion" | "createdAt">, dates: string[], today = berlinDateIso()) {
  return evaluatePrescription({
    rulesVersion: vo.rulesVersion,
    importedOn: vo.createdAt ? berlinDateIso(vo.createdAt) : null,
    issuedAt: vo.issuedAt,
    urgent: vo.urgent,
    units: vo.units,
    status: vo.status,
    frequency: vo.frequencyPerWeek,
    treatmentDates: dates,
    today,
    startBy: vo.startBy,
    reopenedOn: vo.reopenedAt,
  });
}

/** IK der Praxis (für die Pflichtangaben-Prüfung, Anlage 3 Buchst. p) */
async function practiceIk(tx: Tx, org: string): Promise<string | null> {
  const [o] = await tx.select({ ik: organizations.ik }).from(organizations).where(eq(organizations.id, org));
  return o?.ik ?? null;
}

/** Pflichtangaben nach Anlage 3 – nur für Verordnungen ab dem Regelwerk mit den Anlage-3-Feldern (hasAnlage3Fields, PR #111 C3). */
export function findingsFor(vo: PrescriptionRow, practiceIkValue: string | null): Finding[] {
  if (!hasAnlage3Fields(vo.rulesVersion)) return [];
  return anlage3Findings({
    diagnosisGroup: vo.diagnosisGroup,
    issuedAt: vo.issuedAt,
    units: vo.units,
    icd10: vo.icd10,
    icd10Second: vo.icd10Second,
    diagnosisText: vo.diagnosisText,
    leitsymptomatik: vo.leitsymptomatik,
    leitsymptomatikText: vo.leitsymptomatikText,
    frequency: vo.frequencyPerWeek,
    remedy: vo.remedy,
    positions: vo.positions,
    homeVisit: vo.homeVisit,
    insurerIk: vo.insurerIk,
    insuranceNumber: vo.insuranceNumber,
    insuredStatus: vo.insuredStatus,
    doctorLanr: vo.doctorLanr,
    doctorBsnr: vo.doctorBsnr,
    doctorSigned: vo.doctorSigned,
    practiceIk: practiceIkValue,
  });
}

/**
 * Abgelaufene Verordnungen als „Frist überschritten“ kennzeichnen (status expired + Grund) – nie löschen.
 * Beginnfrist verpasst (HeilM-RL § 15, Vertrag § 6 Abs. 4) oder 12 Wochen Unterbrechung (Vertrag § 7 Abs. 7).
 * Nur in protokollierten Pfaden mit Schreibrecht (canAutoExpire: Akte, Übersicht; danach auditExpired) – lesende
 * Pfade (Doku-Auswahl, Terminplanung, Besuchstag) filtern nur (PR #111 H1/C2). Nur Verordnungen ab dem aktuellen
 * Regelwerk (autoExpiryApplies) – Übernahmen und Altbestand nicht (PR #111 C1). Gibt die geänderten IDs zurück.
 */
export async function expireOverdue(tx: Tx, org: string, rows: PrescriptionRow[], usage: Map<string, string[]>, today = berlinDateIso()): Promise<string[]> {
  const changed: string[] = [];
  for (const r of rows) {
    if (r.status !== "open" && r.status !== "active") continue;
    if (!autoExpiryApplies(r.rulesVersion)) continue;
    const ev = evaluate(r, usage.get(r.id) ?? [], today);
    if (!ev.expiry) continue;
    const done = await tx
      .update(prescriptions)
      .set({ status: "expired", expiredReason: ev.expiry })
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, r.id), inArray(prescriptions.status, ["open", "active"])))
      .returning({ id: prescriptions.id });
    if (done.length) {
      r.status = "expired";
      r.expiredReason = ev.expiry;
      changed.push(r.id);
    }
  }
  return changed;
}

/** Darf dieser Aufruf Verordnungen automatisch ablaufen lassen? Schreibrecht, kein Support-/Nur-Lesen-Modus (H1). */
export function canAutoExpire(auth: AuthContext): boolean {
  return auth.can("medical.write") && !auth.support && !auth.readOnly;
}

async function auditExpired(auth: AuthContext, ids: string[]) {
  for (const id of ids) await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "prescription.expired", entity: "prescription", entityId: id, meta: { automatic: true } });
}

/** Entfernt medizinische Details (für Rollen ohne medical.read). */
export function redact(vo: PrescriptionRow): PrescriptionRow {
  return {
    ...vo,
    diagnosisGroup: "",
    icd10: null,
    icd10Second: null,
    diagnosisText: null,
    leitsymptomatik: null,
    leitsymptomatikText: null,
    accident: false,
    bvg: false,
    remedy: null,
    positions: [],
    doctorName: null,
    doctorLanr: null,
    doctorBsnr: null,
    interruptionNote: null,
    scanMediaId: null,
    priceSnapshot: null,
    // Kennzeichen „04“/Genehmigung lassen auf den Heilmittelbedarf schließen (GKV Paket C)
    prescriptionKind: null,
    prescriptionKindConfirmedAt: null,
    prescriptionKindConfirmedBy: null,
    prescriptionSpecial: null,
    approvalRef: null,
    approvalDate: null,
  };
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
    const expired = canAutoExpire(auth) ? await expireOverdue(tx, org, rows, usage) : [];
    const ik = await practiceIk(tx, org);
    const ids = rows.map((r) => r.id);
    const signatures = await missingSignatureCounts(tx, org, ids);
    const receipts = await copaymentReceiptsFor(tx, org, ids);
    const reports = await reportsFor(tx, org, ids);
    const followUps = await followUpForPatient(tx, org, patientId);
    const deductions = await deductionsFor(tx, org, ids);
    const corrections = await correctionsFor(tx, org, ids);
    return {
      patient: p,
      expired,
      practiceIk: ik,
      prescriptions: rows.map((r) => ({
        ...r,
        dates: usage.get(r.id) ?? [],
        evaluation: evaluate(r, usage.get(r.id) ?? []),
        findings: findingsFor(r, ik),
        /** Behandlungen ohne Unterschrift/Papier-Vermerk (Leistungsnachweis) */
        signatures: signatures.get(r.id) ?? { total: 0, missing: 0 },
        signatureRequired: signatureRequired(r.rulesVersion),
        /** Zuzahlungsquittungen (Paket B) und quittierte Summe */
        copaymentReceipts: receipts.get(r.id) ?? [],
        /** Summe der gültigen Zuzahlungsquittungen (ZZ-Belege) – ohne Altvermerk (Paket-B-Nachzug) */
        copaymentCollectedCents: collectedCents(receipts.get(r.id)),
        /** Altvermerk (vor Paket B, ohne Beleg) – zählt als erhalten (Review R2-5), wird aber getrennt ausgewiesen */
        copaymentLegacyCents: legacyCopayment(r)?.cents ?? 0,
        /** erwartete und offene Zuzahlung – dieselbe Berechnung wie beim Quittieren (Review R3-2) */
        copaymentDue: copaymentDue(r, p, usage.get(r.id) ?? [], receipts.get(r.id)),
        /** Therapiebericht (Paket B Teil 2): vorhanden bzw. per 78530 verordnet/angefordert */
        therapyReport: reports.get(r.id) ? { id: reports.get(r.id)!.id, reportDate: reports.get(r.id)!.reportDate } : null,
        therapyReportOrdered: reportOrdered(r.positions),
        /** Hinweis „Folgeverordnung anfordern“ (nur neueste Verordnung) */
        followUp: followUps.get(r.id) ?? null,
        /** GKV Paket C: Vorschlag Kennzeichen Verordnungsart (nur Hinweis, nie gesetzt), Absetzungen, Korrekturvermerke */
        kindSuggestion: r.prescriptionKind ? null : suggestPrescriptionKind(r),
        deductions: deductions.get(r.id) ?? [],
        corrections: corrections.get(r.id) ?? [],
      })),
    };
  });
  if (result) {
    await auditExpired(auth, result.expired);
    await audit({ organizationId: org, userId: auth.user.id, action: "prescriptions.read", entity: "patient", entityId: patientId });
  }
  return result;
}

/** Verordnung zur Auswahl in Doku und Terminplanung */
export type BookablePrescription = {
  id: string;
  label: string;
  remaining: number;
  units: number;
  warning: string | null;
  /** Abweichung von der Frequenz, wenn heute behandelt würde → Begründung Pflicht */
  deviation: FrequencyDeviation | null;
  deviationText: string | null;
  lastDate: string | null;
  diagnosisGroup: string;
  frequency: string | null;
  issuedAt: string;
  urgent: boolean;
  startBy: string | null;
  reopenedAt: string | null;
  /** Beginn erfasst, außerhalb erfolgt (Übernahme) oder per Wiederaufnahme bestätigt → keine Beginnfrist-Warnung */
  started: boolean;
  dates: string[];
};

/**
 * Für die Doku, die Terminplanung und den Besuchstag: Verordnungen der Personen, auf die noch Einheiten gebucht werden
 * können – je Person, mit EINER Abfrage für alle (Besuchstag ohne N+1). Rein lesend: abgelaufene Verordnungen werden
 * nur ausgefiltert, nicht gekennzeichnet (PR #111 H1/C2 – das passiert nur in protokollierten Pfaden, expireOverdue).
 * `medical` = false: Bezeichnung ohne Diagnosegruppe.
 */
export async function bookablePrescriptionsFor(tx: Tx, org: string, patientIds: string[], opts: { medical?: boolean; today?: string } = {}): Promise<Map<string, BookablePrescription[]>> {
  const out = new Map<string, BookablePrescription[]>();
  if (!patientIds.length) return out;
  const today = opts.today ?? berlinDateIso();
  const rows = await tx
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.patientId, patientIds), inArray(prescriptions.status, ["open", "active"])))
    .orderBy(asc(prescriptions.issuedAt), asc(prescriptions.createdAt));
  const usage = await usageFor(tx, org, rows.map((r) => r.id));
  for (const r of rows) {
    const dates = usage.get(r.id) ?? [];
    const ev = evaluate(r, dates, today);
    // abgelaufen (wie prescriptionGate) oder keine Einheit mehr frei → nicht buchbar
    if (ev.expiry || ev.unitsRemaining <= 0) continue;
    const lastDate = dates.at(-1) ?? null;
    const deviation = frequencyDeviation({ group: r.diagnosisGroup, frequency: r.frequencyPerWeek, lastDate, date: today });
    const label = opts.medical === false ? `Verordnung vom ${dateDe(r.issuedAt)} · noch ${ev.unitsRemaining} von ${r.units} Einheiten` : prescriptionLabel(r, ev.unitsRemaining);
    const list = out.get(r.patientId) ?? [];
    list.push({
      id: r.id,
      label,
      remaining: ev.unitsRemaining,
      units: r.units,
      warning: ev.messages[0] ?? null,
      deviation,
      deviationText: deviation ? frequencyDeviationText(deviation) : null,
      lastDate,
      diagnosisGroup: r.diagnosisGroup,
      frequency: r.frequencyPerWeek ?? (DIAGNOSIS_GROUPS[r.diagnosisGroup as DiagnosisGroup]?.defaultFrequency ?? null),
      issuedAt: r.issuedAt,
      urgent: r.urgent,
      startBy: r.startBy,
      reopenedAt: r.reopenedAt,
      started: ev.startState === "started",
      dates,
    });
    out.set(r.patientId, list);
  }
  return out;
}

/** wie bookablePrescriptionsFor, für eine Person */
export async function bookablePrescriptions(tx: Tx, org: string, patientId: string, opts: { medical?: boolean; today?: string } = {}): Promise<BookablePrescription[]> {
  return (await bookablePrescriptionsFor(tx, org, [patientId], opts)).get(patientId) ?? [];
}

/** Übersicht aller laufenden Verordnungen der Praxis (Ampel). */
export async function listRunningPrescriptions(auth: AuthContext, statuses: PrescriptionStatus[] = ["open", "active", "completed", "billing_ready", "correction_needed"]) {
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
    const expired = canAutoExpire(auth) ? await expireOverdue(tx, org, list.map((r) => r.vo), usage) : [];
    const ik = await practiceIk(tx, org);
    // Ohne medizinisches Leserecht (Empfang): nur Fristen/Einheiten, keine Diagnose-/Arztdetails
    const out = list
      .filter((r) => (statuses as string[]).includes(r.vo.status))
      .map((r) => ({ ...r, vo: medical ? r.vo : redact(r.vo), evaluation: evaluate(r.vo, usage.get(r.vo.id) ?? []), findings: medical ? findingsFor(r.vo, ik) : [] }));
    return { out, expired };
  });
  await auditExpired(auth, rows.expired);
  await audit({ organizationId: org, userId: auth.user.id, action: "prescriptions.list", meta: { n: rows.out.length } });
  return rows.out;
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
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const today = berlinDateIso();
  // erst jede Zeile prüfen (Einheiten ≥ 1), dann doppelte Positionsnummern zusammenfassen – PR #111 Runde 2/3 (H-2)
  const prepared = preparePositions(d.positions.map((p) => ({ ...(p.position ? { position: p.position } : {}), label: p.label, units: p.units })));
  if ("error" in prepared) return { error: prepared.error };
  const positions = prepared.positions;
  // UI1/UI2: Höchstmenge laut Katalog ist abrechenbar, mehr nicht – trotzdem speichern (Warnung), siehe validatePrescription
  const check = validatePrescription({ issuedAt: d.issuedAt, diagnosisGroup: d.diagnosisGroup, units: d.units, positions, icd10: d.icd10, today });
  if (check.errors.length) return { error: check.errors[0] };

  const ocr = d.source === "ocr" ? parseImportData(d.importData) : null;
  if (d.source === "ocr" && !ocr) return { error: "Die ausgelesenen Daten sind ungültig – bitte erneut auslesen oder manuell erfassen." };
  if (ocr && !d.scanMediaId) return { error: "Zur Auslesung gehört das Foto der Verordnung." };

  const run = async (tx: Tx): Promise<{ error: string } | { id: string; warnings: string[]; created: boolean; correction?: boolean; changedFields?: string[] }> => {
    const [p] = await tx
      .select({ id: patients.id, birthDate: patients.birthDate, copaymentExemptions: patients.copaymentExemptions })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId)));
    if (!p) return { error: "Patient nicht gefunden." };
    if (d.scanMediaId) {
      const [m] = await tx.select({ id: media.id }).from(media).where(and(eq(media.organizationId, org), eq(media.id, d.scanMediaId), eq(media.patientId, d.patientId), eq(media.purpose, "prescription")));
      if (!m) return { error: "Das Foto der Verordnung gehört nicht zu diesem Patienten." };
    }
    // Zuzahlung (Schätzung): Preise aus der bundeseinheitlichen Vergütungsliste (Anlage 2) zum heutigen Datum,
    // Altpositionen ohne Listenpreis aus dem Leistungskatalog (Feld „GKV-Position“). Endgültig: Preis-Snapshot bei
    // Abrechnungsreife mit den echten Behandlungstagen (changePrescriptionStatus).
    const codes = positions.map((x) => x.position).filter((x): x is string => !!x && !priceFor(x, today));
    const priced = codes.length
      ? await tx.select({ gkvPosition: services.gkvPosition, priceCents: services.priceCents }).from(services).where(and(eq(services.organizationId, org), inArray(services.gkvPosition, codes), isNotNull(services.gkvPosition)))
      : [];
    const catalogPrice = new Map(priced.map((s) => [s.gkvPosition, s.priceCents]));
    const cost = remedyCostCents(positions.map((x) => ({ units: x.units, priceCents: x.position ? (priceFor(x.position, today)?.cents ?? catalogPrice.get(x.position)) : null })));
    const maxUnits = Math.max(0, ...positions.map((x) => x.units));
    // Schätzung: je Einheit ein eigener (gedachter) Behandlungstag ab heute – mehrere Einträge am selben Tag zählen seit
    // Runde 4 nur einmal je Tag (priceSnapshot), gleiche Tage würden die Zuzahlung zu niedrig schätzen
    const estimate = priceSnapshot({ positions, treatmentDates: Array.from({ length: maxUnits }, (_, i) => addDaysIso(today, i)), birthDate: p.birthDate, exemptions: p.copaymentExemptions, computedOn: today, insurerIk: d.insurerIk });
    const warnings = [...check.warnings];
    if (!cost.complete) warnings.push("Für mindestens eine Position gibt es keinen Preis in der Vergütungsliste Podologie (Anlage 2) – Zuzahlung bitte prüfen.");
    const exemption = exemptOn(p.copaymentExemptions, today);
    if (d.copaymentExempt && !exemption) {
      warnings.push("„Zuzahlungsfrei“ ist angekreuzt, aber es ist keine gültige Befreiungsbescheinigung hinterlegt – auf die Zuzahlung darf nur mit Bescheinigung verzichtet werden.");
    }
    // Bescheinigung „der Krankenkasse“ (Vertrag § 8 Abs. 3): von einer anderen Kasse als auf der VO → bitte prüfen
    if (exemption?.insurerIk && d.insurerIk && normalizeId(exemption.insurerIk) !== normalizeId(d.insurerIk)) {
      warnings.push(`Die gültige Befreiungsbescheinigung ist von einer anderen Krankenkasse (IK ${exemption.insurerIk}) als auf der Verordnung (IK ${d.insurerIk}) – bitte prüfen (Kassenwechsel?).`);
    }
    const ik = await practiceIk(tx, org);
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
      icd10Second: d.icd10Second ?? null,
      diagnosisText: d.diagnosisText ?? null,
      leitsymptomatik: d.leitsymptomatik ?? null,
      leitsymptomatikText: d.leitsymptomatikText ?? null,
      insurerIk: d.insurerIk ?? null,
      insuranceNumber: d.insuranceNumber ?? null,
      insuredStatus: d.insuredStatus ?? null,
      accident: d.accident,
      bvg: d.bvg,
      doctorSigned: d.doctorSigned ? true : d.doctorSignedAsked ? false : null,
      startBy: startDeadline(d.issuedAt, d.urgent),
      copaymentCents: d.copaymentExempt && !estimate.lines.length ? 0 : estimate.copaymentCents,
      rulesVersion: RULES_VERSION,
      ...(d.scanMediaId ? { scanMediaId: d.scanMediaId } : {}),
      ...(ocr ? { source: "ocr", importData: ocr } : {}),
    };
    const findings = findingsFor({ ...(values as unknown as PrescriptionRow), rulesVersion: RULES_VERSION }, ik);
    for (const f of findings) warnings.push(`${f.level === "warning" ? "Hinweis" : f.level === "start" ? "Fehler (Behandlung darf nicht beginnen)" : "Fehler (vor Abrechnung korrigieren)"}: ${f.message}`);
    if (d.id) {
      const [old] = await tx
        .select({ status: prescriptions.status, rulesVersion: prescriptions.rulesVersion, copaymentCents: prescriptions.copaymentCents })
        .from(prescriptions)
        .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id), eq(prescriptions.patientId, d.patientId)))
        .for("update");
      if (!old) return { error: "Verordnung nicht gefunden." };
      const used = (await usageFor(tx, org, [d.id])).get(d.id)?.length ?? 0;
      // „Korrektur nötig“ (GKV Paket C): abgerechnete Verordnung nach Korrekturvermerk wieder bearbeitbar – Regelwerk und
      // Zuzahlung der Erstabrechnung bleiben (neuer Snapshot erst mit „abrechnungsreif“), Änderung im Audit als Korrektur
      if (old.status === "correction_needed") {
        if (d.units < used) return { error: `Es sind schon ${used} Einheiten erbracht – weniger verordnete Einheiten sind nicht möglich.` };
        const before = await prescriptionJson(tx, org, d.id);
        await tx.update(prescriptions).set({ ...values, rulesVersion: old.rulesVersion, copaymentCents: old.copaymentCents }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.id)));
        // Audit: Namen der geänderten Felder (keine Werte – Diagnosen/ICD), damit keine Änderung im Korrekturstatus still bleibt
        const changedFields = changedPrescriptionFields(before, await prescriptionJson(tx, org, d.id));
        return { id: d.id, warnings, created: false, correction: true, changedFields };
      }
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
    audit({ organizationId: org, userId: auth.user.id, action: result.created ? "prescription.create" : "prescription.update", entity: "prescription", entityId: result.id, meta: { patientId: d.patientId, rulesVersion: RULES_VERSION, source: ocr ? "ocr" : undefined, edited: ocr?.edited, correction: result.correction || undefined, changedFields: result.changedFields } });
  if (opts.tx) return { id: result.id, warnings: result.warnings, afterCommit: writeAudit };
  await writeAudit();
  return { id: result.id, warnings: result.warnings };
}

export async function changePrescriptionStatus(
  auth: AuthContext,
  input: { id: string; patientId: string; to: PrescriptionStatus; interruptionNote?: string | null },
): Promise<{ ok: true; warning?: string } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const today = berlinDateIso();
  const result = await withOrg(org, async (tx) => {
    const [vo] = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.id), eq(prescriptions.patientId, input.patientId))).for("update");
    if (!vo) return { error: "Verordnung nicht gefunden." };
    if (input.to === "billed") return { error: "„Abgerechnet“ wird nur über einen Abrechnungslauf gesetzt." };
    const used = (await usageFor(tx, org, [vo.id])).get(vo.id)?.length ?? 0;
    // Wiederaufnahme aus „Frist überschritten“: Begründung kommt im selben Feld, gehört aber nicht in den
    // Abbruch-/Unterbrechungsvermerk (der geht in den Abrechnungsexport) → reopen_note (PR #111 C1)
    const reopen = vo.status === "expired" && (input.to === "open" || input.to === "active");
    const note = reopen ? input.interruptionNote?.trim() || null : input.interruptionNote?.trim() || vo.interruptionNote;
    // offener Korrekturvermerk (GKV Paket C): Rückweg „abrechnungsreif“ → „Korrektur nötig“ und Hinweis zur Zuzahlung
    const [openCorrection] = vo.status === "correction_needed" || vo.status === "billing_ready" || input.to === "correction_needed"
      ? await tx.select().from(prescriptionCorrections).where(and(eq(prescriptionCorrections.organizationId, org), eq(prescriptionCorrections.prescriptionId, vo.id), isNull(prescriptionCorrections.resolvedAt)))
      : [];
    const t = canTransition(vo.status as PrescriptionStatus, input.to, { unitsUsed: used, units: vo.units, interruptionNote: note, rulesVersion: vo.rulesVersion, openCorrection: !!openCorrection });
    if (!t.ok) return { error: t.reason };
    const extra: Partial<typeof prescriptions.$inferInsert> = reopen ? {} : { interruptionNote: note ?? null };
    let auditMeta: Record<string, unknown> = {};
    let warning: string | null = null;
    if (input.to === "billing_ready") {
      // Pflichtangaben (Anlage 3): Korrekturen müssen vor Einreichung zur Abrechnung erfolgt sein
      const findings = findingsFor(vo, await practiceIk(tx, org));
      const block = findings.find((f) => f.level !== "warning");
      if (blocksBilling(findings) && block) return { error: `Noch nicht abrechnungsreif: ${block.message}` };
      // Leistungsnachweis: jede Behandlung mit Unterschrift der versicherten Person bzw. bewusstem Papier-Vermerk
      // (Anlage 3 Buchst. o, GKV Paket B) – für Verordnungen nach aktuellem Regelwerk
      if (signatureRequired(vo.rulesVersion)) {
        const sig = (await missingSignatureCounts(tx, org, [vo.id])).get(vo.id);
        if (sig?.missing) return { error: `Noch nicht abrechnungsreif: ${sig.missing === 1 ? "Eine Behandlung hat" : `${sig.missing} Behandlungen haben`} keine Unterschrift der versicherten Person – bitte im Leistungsnachweis nachtragen oder „Unterschrift auf der Papier-Verordnung“ vermerken.` };
      }
      // Preis-Snapshot mit den echten Behandlungstagen (Preis nach Behandlungsdatum, Zuzahlung je Tag)
      const [pt] = await tx.select({ birthDate: patients.birthDate, copaymentExemptions: patients.copaymentExemptions, insurerIk: patients.insurerIk }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, vo.patientId)));
      const dates = (await usageFor(tx, org, [vo.id])).get(vo.id) ?? [];
      // vorzeitig beendet = Abbruchvermerk UND weniger Einheiten erbracht als verordnet → 78610 nur einmal je Tag
      // (Runde 2; Runde 3 H-4: ein alter Vermerk nach Wiederaufnahme und vollständiger Behandlung zählt nicht)
      const endedEarly = !!note && used < vo.units;
      // Therapiebericht (78530) zählt mit dem Berichtsdatum (Paket B Teil 2)
      const reportDate = await therapyReportDate(tx, org, vo.id);
      const snap = priceSnapshot({ positions: vo.positions, treatmentDates: dates, birthDate: pt?.birthDate, exemptions: pt?.copaymentExemptions, computedOn: today, insurerIk: vo.insurerIk ?? pt?.insurerIk ?? null, endedEarly, therapyReportDate: reportDate });
      // ohne Preis für jede Position und jeden Behandlungstag keine korrekten Heilmittelkosten/Zuzahlung (PR #111 S2)
      if (!snap.complete) return { error: `Noch nicht abrechnungsreif: Preis fehlt. ${snap.notes.filter((n) => n.startsWith("Kein Preis")).join(" ") || "Keine Behandlung erfasst."} Bitte jeder Position eine Positionsnummer aus der Vergütungsliste zuordnen.` };
      // Kennzeichen Verordnungsart (Anlage 3 § 302, 8.1.12) muss bestätigt sein – nie raten (GKV Paket C)
      if (!vo.prescriptionKind) return { error: `Noch nicht abrechnungsreif: ${KIND_MISSING}` };
      Object.assign(extra, { priceSnapshot: snap, remedyCostCents: snap.remedyCents, copaymentCents: snap.copaymentCents });
      // bisherigen Snapshot nachvollziehbar halten, wenn neu berechnet wird (billing_ready → completed → billing_ready, S1)
      auditMeta = { snapshot: { remedyCents: snap.remedyCents, copaymentCents: snap.copaymentCents, computedOn: snap.computedOn }, ...(vo.priceSnapshot ? { previousSnapshot: vo.priceSnapshot } : {}) };
      // 78530 verordnet, aber kein Bericht → wird nicht abgerechnet; Hinweis statt Sperre (Review R2-23)
      if (!reportDate && reportOrdered(vo.positions)) warning = "Therapiebericht fehlt – Position 78530 wird nicht abgerechnet. Bericht erstellen und „abrechnungsreif“ erneut setzen, falls er angefordert war.";
      // Neuabrechnung nach Korrektur: geändertes Zuzahlungs-Soll anzeigen (nicht blockieren) – gegenüber der
      // Erstabrechnung und gegenüber bereits ausgestellten Zuzahlungsquittungen (+ Altvermerk)
      if (openCorrection) {
        const hint = rebillCopaymentHint(snap.copaymentCents, openCorrection.originalCopaymentCents, collectedCents((await copaymentReceiptsFor(tx, org, [vo.id])).get(vo.id)) + (legacyCopayment(vo)?.cents ?? 0));
        if (hint) warning = warning ? `${warning} ${hint}` : hint;
      }
    }
    if (vo.status === "billing_ready" && input.to === "completed" && vo.priceSnapshot) auditMeta = { previousSnapshot: vo.priceSnapshot };
    if (input.to === "expired") extra.expiredReason = vo.expiredReason ?? "manual";
    if (reopen) Object.assign(extra, { expiredReason: null, reopenedAt: today, reopenNote: note });
    await tx.update(prescriptions).set({ status: input.to, ...extra }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, vo.id)));
    return { ok: true as const, from: vo.status, warning, meta: reopen ? { reopen: true, note, expiredReason: vo.expiredReason } : auditMeta };
  });
  if ("error" in result) return { error: result.error ?? "Fehler" };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.status", entity: "prescription", entityId: input.id, meta: { from: result.from, to: input.to, ...result.meta } });
  return result.warning ? { ok: true, warning: result.warning } : { ok: true };
}

export const COPAYMENT_METHODS = { cash: "bar", card: "Karte", transfer: "Überweisung", other: "sonstig" } as const;
export const COPAYMENT_LEGACY_BLOCKED = "„Zuzahlung erhalten“ wird jetzt als Zuzahlungsquittung erfasst (mit Kassenbuchung) – bitte „Zuzahlung quittieren“ verwenden.";
export type CopaymentMethod = keyof typeof COPAYMENT_METHODS;

/**
 * Altvermerk „Zuzahlung erhalten“ (vor Paket B: nur Datum/Betrag/Zahlungsart an der Verordnung, nie in der Kasse
 * gebucht). Seit Paket B wird die Zuzahlung als Zuzahlungsquittung erfasst (src/server/copayments.ts) – neue
 * Altvermerke sind nicht mehr möglich (`paid: true` → Fehler). Ein Altvermerk gilt als erhalten; entfernt werden darf er
 * nur als „Vermerk war falsch – nichts erhalten“ mit Pflichtbegründung (Review R2-5) – nie, um früher erhaltene Beträge
 * nachträglich zu quittieren (keine nachträgliche Kassenbuchung). Recht: Rechnungen schreiben + medizinisch lesen (R2-11).
 */
export async function setCopaymentPaid(
  auth: AuthContext,
  input: { id: string; patientId: string; paid: boolean; amountCents?: number | null; method?: CopaymentMethod | null; reason?: string | null },
): Promise<{ error: string } | { warning?: string }> {
  assertCan(auth, "invoices.write", "medical.read");
  const blocked = gkvGuard(auth.organization, "copayment");
  if (blocked) return blocked;
  if (input.paid) return { error: COPAYMENT_LEGACY_BLOCKED };
  const reason = (input.reason ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (reason.length < NOTE_MIN) return { error: "Begründung fehlt: bitte angeben, warum der Vermerk falsch war (mind. 5 Zeichen)." };
  const org = auth.organization.id;
  const done = await withOrg(org, async (tx) => {
    const [vo] = await tx
      .select({ paidAt: prescriptions.copaymentPaidAt, cents: prescriptions.copaymentPaidCents, method: prescriptions.copaymentPaidMethod })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.id), eq(prescriptions.patientId, input.patientId)))
      .for("update");
    if (!vo) return null;
    // kein Altvermerk → nichts zu entfernen, kein Audit (Review R3-7)
    if (!vo.paidAt) return "none" as const;
    await tx
      .update(prescriptions)
      .set({ copaymentPaidAt: null, copaymentPaidCents: null, copaymentPaidMethod: null })
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.id)));
    return vo;
  });
  if (!done) return { error: "Verordnung nicht gefunden." };
  if (done === "none") return { error: "Für diese Verordnung ist kein Vermerk vorhanden – nichts zu entfernen." };
  // bisherigen Altvermerk nachvollziehbar halten (Betrag/Zahlungsart/Datum stehen danach nur noch im Protokoll)
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.copayment", entity: "prescription", entityId: input.id, meta: { paid: false, wrongEntry: true, reason, legacy: { at: done.paidAt!.toISOString(), cents: done.cents, method: done.method } } });
  return {};
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
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) return blocked;
  const org = auth.organization.id;
  if (!ids.length) return { error: "Bitte mindestens eine Verordnung auswählen." };
  const result = await withOrg(org, async (tx) => {
    const rows = await tx
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.id, ids), eq(prescriptions.status, "billing_ready")))
      .for("update");
    if (rows.length !== ids.length) return { error: "Einige Verordnungen sind nicht (mehr) abrechnungsreif. Bitte Seite neu laden." };
    // ohne vollständigen Preis-Snapshot keine korrekten Heilmittelkosten/Zuzahlung (Altbestand vor dem Snapshot,
    // fehlender Preis) → nicht übergeben; „Abrechnungsreif zurücknehmen“ und neu setzen erzeugt den Snapshot (Review-Runde 2)
    const incomplete = rows.filter((r) => !(r.priceSnapshot as PriceSnapshot | null)?.complete);
    if (incomplete.length) return { error: `${incomplete.length === 1 ? "Eine Verordnung hat" : `${incomplete.length} Verordnungen haben`} keinen vollständigen Preis-Snapshot – bitte „Abrechnungsreif zurücknehmen“ und erneut auf „Abrechnungsreif“ setzen (Preise prüfen).` };
    // Kennzeichen Verordnungsart nicht bestätigt (Bestand vor Paket C) → erst bestätigen, nie raten
    const noKind = rows.filter((r) => !r.prescriptionKind);
    if (noKind.length) return { error: `${noKind.length === 1 ? "Eine Verordnung hat" : `${noKind.length} Verordnungen haben`} kein bestätigtes Kennzeichen Verordnungsart (03/04) – bitte in der Akte unter „Abrechnungsangaben“ wählen.` };
    const total = rows.reduce((s, r) => s + (r.copaymentCents ?? 0), 0);
    // Heilmittelkosten aus den Preis-Snapshots (fehlt einer → Summe unvollständig, Spalte bleibt trotzdem die Summe der vorhandenen)
    const remedyTotal = rows.reduce((s, r) => s + (r.remedyCostCents ?? 0), 0);
    const [batch] = await tx
      .insert(billingBatches)
      .values({ organizationId: org, createdBy: auth.user.id, partner: opts.partner, status: "draft", prescriptionCount: rows.length, totalCents: total, copaymentTotalCents: total, remedyTotalCents: remedyTotal, note: opts.note ?? null })
      .returning({ id: billingBatches.id });
    const now = new Date();
    await tx.update(prescriptions).set({ status: "billed", billedAt: now, billingBatchId: batch.id }).where(and(eq(prescriptions.organizationId, org), inArray(prescriptions.id, ids)));
    // erneut abgerechnete Korrekturen (GKV Paket C) als „erneut abgerechnet in diesem Lauf“ abschließen
    const rebilled = await resolveCorrectionsRebilled(tx, org, auth.user.id, ids, batch.id);
    return { id: batch.id, count: rows.length, rebilled };
  });
  if ("error" in result) return result;
  await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.create", entity: "billing_batch", entityId: result.id, meta: { count: result.count, partner: opts.partner, ...(result.rebilled ? { rebilledCorrections: result.rebilled } : {}) } });
  return result;
}

/** Spalte „Korrektur“: Bezug der Verordnung zu Korrekturvermerken aus Sicht dieses Laufs */
function correctionNote(list: { originalBatchId: string | null; resolvedBatchId: string | null; resolution: string | null; createdAt: Date }[] | undefined, batchId: string): string {
  if (!list?.length) return "";
  const parts: string[] = [];
  for (const c of list) {
    if (c.originalBatchId === batchId) parts.push(c.resolution === "rebilled" ? "in späterem Lauf neu abgerechnet" : c.resolution === "no_rebill" ? "Korrektur ohne Neuabrechnung" : "Korrektur offen");
    else if (c.resolvedBatchId === batchId) parts.push(`Neuabrechnung nach Korrektur vom ${berlinDateIso(c.createdAt)}`);
  }
  return parts.join(" | ");
}

/** Tag der Zuzahlung für den Export: letzte gültige Zuzahlungsquittung, sonst Altvermerk (copayment_paid_at) */
export function copaymentPaidOn(receipts: CopaymentReceiptRow[] | undefined, legacy: Date | null): string {
  const valid = (receipts ?? []).filter((r) => r.status !== "cancelled" && r.issuedAt).map((r) => r.issuedAt!);
  if (valid.length) return valid.sort().at(-1)!;
  return legacy ? berlinDateIso(legacy) : "";
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
  "IK Praxis",
  "Leistungserbringergruppe",
  "IK Krankenkasse",
  "Versichertenstatus",
  "ICD-10 (2)",
  "Diagnose (Klartext)",
  "Leitsymptomatik",
  "Unfallfolgen",
  "BVG",
  "Heilmittelkosten EUR",
  "Preisstand",
  "Zuzahlungsfrei angekreuzt (VO)",
  // GKV Paket C (am Ende angehängt, bestehende Spalten unverändert)
  "Verordnungsart",
  "Verordnungsbesonderheit",
  "Genehmigung Kennzeichen",
  "Genehmigung Datum",
  "Korrektur",
];

/** Zeilen für den neutralen CSV-Export eines Abrechnungslaufs (Übergabe an ein Abrechnungszentrum). */
export async function billingBatchExport(auth: AuthContext, batchId: string) {
  // enthält Diagnosen (ICD-10) → zusätzlich medizinisches Leserecht
  assertCan(auth, "invoices.write", "medical.read");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [batch] = await tx.select().from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    if (!batch) return null;
    const [o] = await tx.select({ ik: organizations.ik, legsCode: organizations.legsCode }).from(organizations).where(eq(organizations.id, org));
    // dazu Verordnungen, die in diesem Lauf abgerechnet und danach zur Korrektur geöffnet bzw. neu abgerechnet wurden
    // (GKV Paket C) – sonst fiele die Verordnung aus dem Export ihres ursprünglichen Laufs
    // – mit dem Stand der Erstabrechnung (original_row), nicht mit den korrigierten Werten (reproduzierbar, Zeilensumme = Laufsumme)
    const corrected = await correctedFromBatch(tx, org, batchId);
    const ids = [...corrected.keys()];
    const rows = (
      await tx
        .select({ vo: prescriptions, p: patients })
        .from(prescriptions)
        .innerJoin(patients, eq(patients.id, prescriptions.patientId))
        .where(and(eq(prescriptions.organizationId, org), ids.length ? or(eq(prescriptions.billingBatchId, batchId), inArray(prescriptions.id, ids)) : eq(prescriptions.billingBatchId, batchId)))
        .orderBy(asc(patients.lastName), asc(prescriptions.issuedAt))
    ).map((r) => ({ ...r, vo: corrected.get(r.vo.id) ?? r.vo }));
    const corrections = await correctionsFor(tx, org, rows.map((r) => r.vo.id));
    const usage = await usageFor(tx, org, rows.map((r) => r.vo.id));
    const receipts = await copaymentReceiptsFor(tx, org, rows.map((r) => r.vo.id));
    if (!batch.exportedAt) {
      await tx.update(billingBatches).set({ exportedAt: new Date(), status: "exported" }).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, batchId)));
    }
    return { batch, rows, usage, receipts, org: o, corrections };
  });
  if (!data) return null;
  const euro = (c: number | null) => ((c ?? 0) / 100).toFixed(2).replace(".", ",");
  const lines: unknown[][] = [GKV_BATCH_HEADER];
  for (const { vo, p } of data.rows) {
    const dates = data.usage.get(vo.id) ?? [];
    lines.push([
      data.batch.id,
      vo.id,
      // Versichertennummer der Verordnung (Stand der Abrechnung bzw. original_row), nicht der heutige Stand der Person
      vo.insuranceNumber || p.insuranceNumber || "",
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
      // tatsächliche Befreiung je Behandlungstag aus dem Preis-Snapshot (Bescheinigung/minderjährig, PR #111 B1);
      // das Kreuz auf der VO steht in der Spalte „Zuzahlungsfrei angekreuzt (VO)“
      exemptionSummary(vo.priceSnapshot as PriceSnapshot | null),
      // Zuzahlungsquittung(en) seit Paket B (letzte gültige), sonst Altvermerk
      copaymentPaidOn(data.receipts.get(vo.id), vo.copaymentPaidAt),
      vo.therapyReportRequested ? "ja" : "nein",
      vo.interruptionNote ?? "",
      vo.rulesVersion ?? "",
      data.org?.ik ?? "",
      data.org?.legsCode ?? "",
      vo.insurerIk ?? p.insurerIk ?? "",
      vo.insuredStatus ?? p.insuredStatus ?? "",
      vo.icd10Second ?? "",
      vo.diagnosisText ?? "",
      vo.leitsymptomatik === "x" ? (vo.leitsymptomatikText ?? "") : (vo.leitsymptomatik ?? ""),
      vo.accident ? "ja" : "nein",
      vo.bvg ? "ja" : "nein",
      vo.remedyCostCents === null ? "" : euro(vo.remedyCostCents),
      [...new Set(((vo.priceSnapshot as { lines?: { tableVersion: string | null }[] } | null)?.lines ?? []).map((l) => l.tableVersion).filter(Boolean))].join(" | "),
      vo.copaymentExempt ? "ja" : "nein",
      vo.prescriptionKind ?? "",
      vo.prescriptionSpecial ? `${vo.prescriptionSpecial} ${PRESCRIPTION_SPECIALS[vo.prescriptionSpecial as PrescriptionSpecial] ?? ""}`.trim() : "",
      vo.approvalRef ?? "",
      vo.approvalDate ?? "",
      correctionNote(data.corrections.get(vo.id), batchId),
    ]);
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "billing_batch.export", entity: "billing_batch", entityId: batchId, meta: { count: data.rows.length } });
  // Formel-Injection verhindern (Namen, Arzt, Freitexte stammen aus Eingaben)
  return { batch: data.batch, lines: neutralizeCsvRows(lines) };
}
