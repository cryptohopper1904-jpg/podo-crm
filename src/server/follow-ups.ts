import "server-only";
import { and, asc, count, desc, eq, exists, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointments, followUpRequests, patients, prescriptions, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { feature, gkvGuard } from "@/lib/features";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { renderFollowUpPdf } from "@/lib/gkv-pdf";
import { FOLLOW_UP_HINT, followUpLetter, followUpReason, type FollowUpReason } from "@/lib/rules/follow-up";
import { assertCan } from "./authz";
import { letterOrg, loadPrescriptionWithPatient, pdfPrescription } from "./gkv-documents";
import { loadLogos } from "./practice-logos";
import { reportsFor } from "./therapy-reports";

/**
 * Folgeverordnung (GKV Paket B Teil 2): Hinweis „Folgeverordnung anfordern“ in der Akte und auf „Heute“, Vorlage
 * „Anforderung Folgeverordnung“ (PDF/Text) an die Ärztin/den Arzt und Vermerk „angefordert am“ (append-only, Audit).
 */

export type FollowUpState = { reason: FollowUpReason; hint: string; requestedOn: string | null };

/** Je Person: neueste (nicht stornierte) Verordnung, Einheiten, Termine ab heute, Dauerpatient:in, Vermerke */
async function latestPrescriptionState(tx: Tx, org: string, patientIds: string[] | null) {
  const where = and(eq(prescriptions.organizationId, org), ne(prescriptions.status, "cancelled"), ...(patientIds ? [inArray(prescriptions.patientId, patientIds)] : []));
  const rows = await tx
    .selectDistinctOn([prescriptions.patientId], { id: prescriptions.id, patientId: prescriptions.patientId, status: prescriptions.status, units: prescriptions.units, issuedAt: prescriptions.issuedAt })
    .from(prescriptions)
    .where(where)
    .orderBy(prescriptions.patientId, desc(prescriptions.issuedAt), desc(prescriptions.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const pids = rows.map((r) => r.patientId);
  const used = await tx
    .select({ id: treatmentRecords.prescriptionId, n: count() })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.prescriptionId, ids)))
    .groupBy(treatmentRecords.prescriptionId);
  const future = await tx
    .select({ patientId: appointments.patientId, n: count() })
    .from(appointments)
    .where(and(eq(appointments.organizationId, org), inArray(appointments.patientId, pids), gte(appointments.startsAt, berlinToUtc(berlinDateIso(), "00:00")), inArray(appointments.status, ["planned", "confirmed"])))
    .groupBy(appointments.patientId);
  const pats = await tx.select({ id: patients.id, followUpExpected: patients.followUpExpected, firstName: patients.firstName, lastName: patients.lastName, title: patients.title, archivedAt: patients.archivedAt }).from(patients).where(and(eq(patients.organizationId, org), inArray(patients.id, pids)));
  const reqs = await tx
    .select({ prescriptionId: followUpRequests.prescriptionId, requestedOn: followUpRequests.requestedOn })
    .from(followUpRequests)
    .where(and(eq(followUpRequests.organizationId, org), inArray(followUpRequests.prescriptionId, ids)))
    .orderBy(asc(followUpRequests.requestedOn));
  // Maps statt find je Zeile (Review R2-23)
  const usedBy = new Map(used.map((u) => [u.id, Number(u.n)]));
  const futureBy = new Map(future.map((f) => [f.patientId, Number(f.n)]));
  const patBy = new Map(pats.map((x) => [x.id, x]));
  const reqBy = new Map<string, string>();
  for (const x of reqs) reqBy.set(x.prescriptionId, x.requestedOn); // aufsteigend → letzter gewinnt
  return rows.map((r) => {
    const unitsUsed = usedBy.get(r.id) ?? 0;
    const p = patBy.get(r.patientId);
    const reason = p?.archivedAt
      ? null
      : followUpReason({
          status: r.status,
          unitsUsed,
          unitsRemaining: Math.max(0, r.units - unitsUsed),
          futureAppointments: futureBy.get(r.patientId) ?? 0,
          followUpExpected: !!p?.followUpExpected,
          // nur die neueste Verordnung je Person wird betrachtet – eine neuere gibt es per Definition nicht
          newerPrescription: false,
        });
    return { ...r, patient: p, reason, requestedOn: reqBy.get(r.id) ?? null };
  });
}

/** Hinweis je Verordnung einer Person (nur die neueste Verordnung kann ihn tragen) */
export async function followUpForPatient(tx: Tx, org: string, patientId: string): Promise<Map<string, FollowUpState>> {
  const out = new Map<string, FollowUpState>();
  for (const r of await latestPrescriptionState(tx, org, [patientId])) {
    if (r.reason) out.set(r.id, { reason: r.reason, hint: FOLLOW_UP_HINT[r.reason], requestedOn: r.requestedOn });
  }
  return out;
}

/** Akte: Hinweis „Folgeverordnung anfordern“ für eine Person (null = keiner) – Recht medical.read */
export async function patientFollowUpHint(auth: AuthContext, patientId: string): Promise<FollowUpState | null> {
  if (!auth.can("medical.read") || !feature(auth.organization, "verordnungen")) return null;
  const org = auth.organization.id;
  const map = await withOrg(org, (tx) => followUpForPatient(tx, org, patientId));
  return [...map.values()][0] ?? null;
}

/** „Heute“: Personen, für die eine Folgeverordnung anzufordern ist (noch nicht angefordert) */
export async function followUpsDue(auth: AuthContext, limit = 6): Promise<{ total: number; items: { patientId: string; name: string; prescriptionId: string; hint: string }[] }> {
  // Hinweis beruht auf Verordnungsdaten → zusätzlich medizinisches Leserecht (Review R2-22)
  assertCan(auth, "patients.read", "medical.read");
  if (!feature(auth.organization, "verordnungen")) return { total: 0, items: [] };
  const org = auth.organization.id;
  const rows = await withOrg(org, async (tx) => {
    // in SQL vorfiltern (Review R2-23): nur Personen mit künftigen Terminen oder Markierung „Dauerpatient:in“
    const candidates = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.organizationId, org),
          isNull(patients.archivedAt),
          or(
            eq(patients.followUpExpected, true),
            exists(
              tx
                .select({ x: appointments.id })
                .from(appointments)
                .where(and(eq(appointments.organizationId, org), eq(appointments.patientId, patients.id), gte(appointments.startsAt, berlinToUtc(berlinDateIso(), "00:00")), inArray(appointments.status, ["planned", "confirmed"]))),
            ),
          ),
        ),
      );
    return candidates.length ? latestPrescriptionState(tx, org, candidates.map((c) => c.id)) : [];
  });
  const due = rows.filter((r) => r.reason && !r.requestedOn);
  return {
    total: due.length,
    items: due.slice(0, limit).map((r) => ({ patientId: r.patientId, name: [r.patient?.title, r.patient?.firstName, r.patient?.lastName].filter(Boolean).join(" "), prescriptionId: r.id, hint: FOLLOW_UP_HINT[r.reason!] })),
  };
}

export const followUpRequestInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  note: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : null), z.string().max(300).nullable()),
});

/** Vermerk „Folgeverordnung angefordert am heute“ (Audit) */
export async function markFollowUpRequested(auth: AuthContext, raw: z.input<typeof followUpRequestInput>): Promise<{ ok: true } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const parsed = followUpRequestInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const org = auth.organization.id;
  const today = berlinDateIso();
  const id = await withOrg(org, async (tx) => {
    const [vo] = await tx.select({ id: prescriptions.id }).from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId)));
    if (!vo) return null;
    const [row] = await tx.insert(followUpRequests).values({ organizationId: org, prescriptionId: d.prescriptionId, patientId: d.patientId, requestedOn: today, note: d.note, createdBy: auth.user.id }).returning({ id: followUpRequests.id });
    return row.id;
  });
  if (!id) return { error: "Verordnung nicht gefunden." };
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.follow_up_requested", entity: "prescription", entityId: d.prescriptionId, meta: { requestId: id, requestedOn: today, patientId: d.patientId } });
  return { ok: true };
}

/** Dauerpatient:in an/aus (Hinweis auch ohne geplante Termine) */
export async function setFollowUpExpected(auth: AuthContext, input: { patientId: string; on: boolean }): Promise<{ ok: true } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  if (!z.string().uuid().safeParse(input.patientId).success) return { error: "Ungültige Anfrage." };
  const org = auth.organization.id;
  const done = await withOrg(org, (tx) => tx.update(patients).set({ followUpExpected: input.on }).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId))).returning({ id: patients.id }));
  if (!done.length) return { error: "Patient nicht gefunden." };
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.follow_up_expected", entity: "patient", entityId: input.patientId, meta: { on: input.on } });
  return { ok: true };
}

/** Vorlage „Anforderung Folgeverordnung“ als PDF oder Text (medical.read) */
export async function followUpDocument(auth: AuthContext, prescriptionId: string, format: "pdf" | "text"): Promise<{ bytes: Uint8Array; filename: string; text: string } | null> {
  assertCan(auth, "medical.read");
  if (gkvGuard(auth.organization, "verordnungen")) return null;
  const org = auth.organization.id;
  const today = berlinDateIso();
  const data = await withOrg(org, async (tx) => {
    const row = await loadPrescriptionWithPatient(tx, org, prescriptionId);
    if (!row) return null;
    const o = await letterOrg(tx, org);
    if (!o) return null;
    const report = (await reportsFor(tx, org, [prescriptionId])).get(prescriptionId) ?? null;
    const recs = await tx
      .select({ treatedAt: treatmentRecords.treatedAt })
      .from(treatmentRecords)
      .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, prescriptionId)));
    return { ...row, o, report, dates: [...new Set(recs.map((r) => berlinDateIso(r.treatedAt)))] };
  });
  if (!data) return null;
  const letter = followUpLetter({
    practice: data.o.legalName || data.o.name,
    doctorName: data.vo.doctorName,
    patient: { name: [data.p.title, data.p.firstName, data.p.lastName].filter(Boolean).join(" "), birthDate: data.p.birthDate, insuranceNumber: data.vo.insuranceNumber ?? data.p.insuranceNumber, insurerName: data.p.insurerName },
    prescription: data.vo,
    treatmentDates: data.dates,
    report: data.report,
    today,
  });
  const text = [`Betreff: ${letter.subject}`, "", ...letter.paragraphs].join("\n\n");
  const bytes = format === "pdf" ? await renderFollowUpPdf({ organization: data.o, logos: await loadLogos(org), prescription: pdfPrescription(data.vo), letter, date: today }) : new TextEncoder().encode(text);
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.follow_up_document", entity: "prescription", entityId: prescriptionId, meta: { format, patientId: data.p.id } });
  return { bytes, text, filename: `Anforderung-Folgeverordnung-${today}-${prescriptionId.slice(0, 8)}.${format === "pdf" ? "pdf" : "txt"}` };
}
