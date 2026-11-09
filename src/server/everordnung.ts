import "server-only";
import { and, eq, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { patients, prescriptions } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { condensedImportData, parseEverordnungText, positionsFrom, type EverordnungSummary } from "@/lib/everordnung/parse";
import { berlinDateIso } from "@/lib/format";
import { DIAGNOSIS_GROUP_CODES, validatePrescription } from "@/lib/rules/prescription";
import { assertCan } from "./authz";
import { gkvGuard } from "@/lib/features";
import { prescriptionInput, savePrescription } from "./prescriptions";

export type PatientCandidate = { id: string; number: number; firstName: string | null; lastName: string; birthDate: string | null; reason: string };

export interface EverordnungPreview {
  summary: EverordnungSummary;
  duplicate: { prescriptionId: string; patientId: string } | null;
  candidates: PatientCandidate[];
}

/** pg-Fehler „unique_violation“ auf dem eVerordnungs-Index (auch in Drizzle-Fehlern verpackt). */
export function isDuplicateRefError(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    const c = cur as { code?: string; constraint?: string };
    if (c.code === "23505" && (!c.constraint || c.constraint === "prescriptions_external_ref_org")) return true;
  }
  return false;
}

async function findExisting(tx: Tx, org: string, externalRef: string) {
  const [row] = await tx
    .select({ prescriptionId: prescriptions.id, patientId: prescriptions.patientId })
    .from(prescriptions)
    .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.externalRef, externalRef)));
  return row ?? null;
}

/** Mögliche Personen: gleiche KVNR oder gleicher Nachname + Geburtsdatum. Keine automatische Zuordnung. */
async function findCandidates(org: string, s: EverordnungSummary): Promise<PatientCandidate[]> {
  const conds: (SQL | undefined)[] = [];
  if (s.patient.kvnr) conds.push(sql`upper(left(coalesce(${patients.insuranceNumber}, ''), 10)) = ${s.patient.kvnr}`);
  if (s.patient.lastName && s.patient.birthDate) conds.push(and(sql`lower(${patients.lastName}) = ${s.patient.lastName.toLowerCase()}`, eq(patients.birthDate, s.patient.birthDate)));
  if (!conds.length) return [];
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, birthDate: patients.birthDate, insuranceNumber: patients.insuranceNumber })
      .from(patients)
      .where(and(eq(patients.organizationId, org), isNull(patients.archivedAt), or(...conds)))
      .limit(5),
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    firstName: r.firstName,
    lastName: r.lastName,
    birthDate: r.birthDate,
    reason: s.patient.kvnr && r.insuranceNumber?.toUpperCase().startsWith(s.patient.kvnr) ? "KVNR stimmt überein" : "Name und Geburtsdatum stimmen überein",
  }));
}

export async function previewEverordnung(auth: AuthContext, text: string): Promise<EverordnungPreview | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "everordnung");
  if (blocked) return blocked;
  const parsed = parseEverordnungText(text);
  if (!parsed.ok) return { error: parsed.error };
  const org = auth.organization.id;
  const duplicate = await withOrg(org, (tx) => findExisting(tx, org, parsed.summary.externalRef));
  const candidates = await findCandidates(org, parsed.summary);
  await audit({ organizationId: org, userId: auth.user.id, action: "everordnung.preview", meta: { duplicate: !!duplicate, candidates: candidates.length } });
  return { summary: parsed.summary, duplicate, candidates };
}

export interface ImportChoice {
  /** bestehende Person (ID aus den Vorschlägen) */
  patientId?: string;
  /** bestehende Person über Kundennummer */
  patientNumber?: number;
  /** neue Person aus den Daten der eVerordnung anlegen */
  createPatient?: boolean;
  diagnosisGroup?: string;
  units?: number;
  issuedAt?: string;
}

const DUPLICATE_MSG = "Diese eVerordnung wurde bereits importiert.";
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** Fachlicher Abbruch innerhalb der Import-Transaktion → Rollback, Meldung an die Oberfläche. */
class ImportAbort extends Error {}

/** Legt aus der eVerordnung einen Verordnungsentwurf (Status „offen“, Herkunft „everordnung“) an. */
export async function importEverordnung(auth: AuthContext, text: string, choice: ImportChoice): Promise<{ id: string; patientId: string; warnings: string[] } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "everordnung");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const parsed = parseEverordnungText(text);
  if (!parsed.ok) return { error: parsed.error };
  const s = parsed.summary;
  if (await withOrg(org, (tx) => findExisting(tx, org, s.externalRef))) return { error: DUPLICATE_MSG };

  // Angaben der Praxis haben Vorrang vor den ausgelesenen Werten
  const diagnosisGroup = choice.diagnosisGroup && (DIAGNOSIS_GROUP_CODES as string[]).includes(choice.diagnosisGroup) ? choice.diagnosisGroup : s.diagnosisGroup;
  const units = choice.units ?? s.units;
  const issuedAt = choice.issuedAt ?? s.issuedAt;
  if (!diagnosisGroup) return { error: "Bitte eine Diagnosegruppe wählen." };
  if (!units) return { error: "Bitte die verordneten Einheiten angeben." };
  if (!issuedAt) return { error: "Bitte das Ausstellungsdatum angeben." };
  const positions = positionsFrom(s, units);
  const icd10 = s.diagnoses[0]?.code;
  const pre = validatePrescription({ issuedAt, diagnosisGroup, units, positions, icd10, today: berlinDateIso() });
  if (pre.errors.length) return { error: pre.errors[0] };

  if (!choice.patientId && !choice.patientNumber) {
    if (!choice.createPatient) return { error: "Bitte eine Person auswählen oder neu anlegen." };
    assertCan(auth, "patients.write");
    if (!s.patient.lastName) return { error: "Die eVerordnung enthält keinen Namen – bitte eine bestehende Person wählen." };
  }

  // Eingaben vorab vollständig prüfen – bevor irgendetwas gespeichert wird (Person wird erst danach bekannt)
  const remedy = [s.remedies.map((r) => r.display).join(", "), s.leitsymptomatik ? `Leitsymptomatik: ${s.leitsymptomatik}` : null].filter(Boolean).join(" · ").slice(0, 300);
  const input = prescriptionInput.safeParse({
    patientId: PLACEHOLDER_ID,
    issuedAt,
    doctorName: s.practitioner.name ?? s.organization.name ?? "",
    doctorLanr: s.practitioner.lanr ?? "",
    doctorBsnr: s.organization.bsnr ?? "",
    diagnosisGroup,
    icd10: icd10 ?? "",
    remedy,
    units: String(units),
    frequencyPerWeek: s.frequency ?? "",
    homeVisit: s.homeVisit,
    urgent: s.urgent,
    copaymentExempt: s.coverage.copaymentExempt,
    therapyReportRequested: s.therapyReport,
    positions: JSON.stringify(positions),
  });
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Daten der eVerordnung unvollständig." };

  // Person bestimmen (nie automatisch), Dublettenprüfung und Verordnung in EINER Transaktion:
  // scheitert irgendein Schritt, bleibt keine neu angelegte Person ohne Verordnung zurück.
  let done: { id: string; patientId: string; created: boolean; warnings: string[]; afterCommit?: () => Promise<void> };
  try {
    done = await withOrg(org, async (tx) => {
      let patientId: string;
      let created = false;
      if (choice.patientId || choice.patientNumber) {
        const [p] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.organizationId, org), choice.patientId ? eq(patients.id, choice.patientId) : eq(patients.number, choice.patientNumber!)));
        if (!p) throw new ImportAbort("Kunde nicht gefunden.");
        patientId = p.id;
        if (await findExisting(tx, org, s.externalRef)) throw new ImportAbort(DUPLICATE_MSG);
      } else {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);
        if (await findExisting(tx, org, s.externalRef)) throw new ImportAbort(DUPLICATE_MSG);
        const [m] = await tx.select({ n: max(patients.number) }).from(patients).where(eq(patients.organizationId, org));
        const [row] = await tx
          .insert(patients)
          .values({
            organizationId: org,
            number: (m?.n ?? 0) + 1,
            lastName: s.patient.lastName!,
            firstName: s.patient.firstName,
            birthDate: s.patient.birthDate,
            street: s.patient.street,
            zip: s.patient.zip,
            city: s.patient.city,
            insuranceType: s.coverage.kind ?? "gkv",
            insurerName: s.coverage.insurerName,
            insuranceNumber: s.patient.kvnr,
            gpName: s.practitioner.name,
            source: "everordnung",
          })
          .returning({ id: patients.id });
        patientId = row.id;
        created = true;
      }
      const res = await savePrescription(auth, { ...input.data, patientId }, { tx, origin: { source: "everordnung", externalRef: s.externalRef, importData: condensedImportData(s) } });
      if ("error" in res) throw new ImportAbort(res.error); // Rollback (auch der neu angelegten Person)
      return { id: res.id, patientId, created, warnings: res.warnings, afterCommit: res.afterCommit };
    });
  } catch (e) {
    if (e instanceof ImportAbort) return { error: e.message };
    if (isDuplicateRefError(e)) return { error: DUPLICATE_MSG };
    throw e;
  }

  // Audit erst nach erfolgreichem Commit
  if (done.created) await audit({ organizationId: org, userId: auth.user.id, action: "patient.create", entity: "patient", entityId: done.patientId, meta: { source: "everordnung" } });
  await done.afterCommit?.();
  await audit({ organizationId: org, userId: auth.user.id, action: "everordnung.import", entity: "prescription", entityId: done.id, meta: { patientId: done.patientId, patientCreated: done.created, warnings: s.warnings.length } });
  return { id: done.id, patientId: done.patientId, warnings: [...s.warnings, ...done.warnings] };
}
