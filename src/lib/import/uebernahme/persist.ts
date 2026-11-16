/**
 * Übernahme-Assistent: Bestand laden und Plan schreiben. Aufruf innerhalb von withOrg(org, (tx) => …), damit RLS greift
 * und alles in EINER Transaktion passiert (Fehler → nichts gespeichert).
 *
 * Schreibt nur dazu: neue Patient:innen, Quell-IDs an verknüpften Personen (nur wenn noch keine ID dieser Quelle da ist),
 * Termine (Quelle „import“), Verordnungen, Dokumente, aus Pododesk außerdem Leistungen mit noch unbekanntem Kürzel und
 * Kalenderfarben für Teammitglieder ohne gewählte Farbe. Nichts wird überschrieben oder gelöscht; alles ist über
 * Quelle + ID bzw. Kürzel wiederholbar (idempotent).
 *
 * Benachrichtigungen: Der Import selbst verschickt nichts. Neu angelegte Personen haben keinen Kanal und keine
 * Einwilligungen (preferred_channel „none“) und bekommen daher auch später keine Erinnerungen. Verknüpfte BESTANDSpersonen
 * behalten ihre Einwilligungen – für ihre übernommenen künftigen Termine kann der Erinnerungslauf Erinnerungen
 * verschicken (die Vorschau weist darauf hin).
 */
import { assertPatientCapacity } from "@/server/patient-limit";
import { and, eq, inArray, isNull, like, max, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import * as s from "@/db/schema";
import { CALENDAR_ROLES, hasOwnCalendar } from "@/lib/auth/permissions";
import { isTherapistColor } from "@/lib/therapist-colors";
import { persistImport, type PersistSummary } from "../excel/persist";
import { legacyPatientNumber } from "../excel/parse";
import type { ExistingSnapshot, ImportPlan, PatientRef } from "./plan";

const CHUNK = 500;
function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Bestand der Praxis für den Abgleich. `documentShas` begrenzt die Dokumentabfrage auf die hochgeladenen PDFs. */
export async function loadExisting(tx: Tx, org: string, documentShas: string[] = []): Promise<ExistingSnapshot> {
  const patients = await tx
    .select({
      id: s.patients.id,
      number: s.patients.number,
      firstName: s.patients.firstName,
      lastName: s.patients.lastName,
      birthDate: s.patients.birthDate,
      email: s.patients.email,
      phoneMobile: s.patients.phoneMobile,
      externalIds: s.patients.externalIds,
      erasedAt: s.patients.contactErasedAt,
    })
    .from(s.patients)
    .where(eq(s.patients.organizationId, org))
    .orderBy(s.patients.number);
  const appts = await tx
    .select({ ref: s.appointments.externalId, patientId: s.appointments.patientId })
    .from(s.appointments)
    .where(
      and(
        eq(s.appointments.organizationId, org),
        eq(s.appointments.source, "import"),
        or(like(s.appointments.externalId, "tinana:%"), like(s.appointments.externalId, "pododesk:%")),
      ),
    );
  const rx = await tx
    .select({ ref: s.prescriptions.externalRef })
    .from(s.prescriptions)
    .where(and(eq(s.prescriptions.organizationId, org), like(s.prescriptions.externalRef, "tinana:%")));
  const docs = documentShas.length
    ? await tx
        .select({ patientId: s.media.patientId, sha: s.media.sha256 })
        .from(s.media)
        .where(and(eq(s.media.organizationId, org), inArray(s.media.sha256, documentShas), isNull(s.media.deletedAt)))
    : [];
  const members = await tx
    .select({ id: s.users.id, name: s.users.name, role: s.memberships.role, color: s.memberships.color })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .where(and(eq(s.memberships.organizationId, org), eq(s.memberships.active, true)));
  const locations = await tx.select({ id: s.locations.id, name: s.locations.name }).from(s.locations).where(eq(s.locations.organizationId, org));
  // auch archivierte Leistungen: Kürzel sind je Praxis eindeutig (Pododesk-Abgleich); Tinana ordnet nur aktive zu
  const services = await tx
    .select({ id: s.services.id, name: s.services.name, code: s.services.code, active: s.services.active })
    .from(s.services)
    .where(eq(s.services.organizationId, org));
  return {
    // gelöschte Personen (Art. 17) bleiben im Abgleich, damit sie nicht neu angelegt werden
    patients: patients.map(({ erasedAt, ...p }) => ({ ...p, externalIds: (p.externalIds ?? {}) as Record<string, unknown>, erased: !!erasedAt })),
    appointmentRefs: new Set(appts.map((a) => a.ref).filter((x): x is string => !!x)),
    // nur Pododesk: Termin-IDs sind je Praxis fortlaufend und können zwischen Praxen kollidieren (R3-2)
    appointmentPatients: new Map(appts.flatMap((a) => (a.ref?.startsWith("pododesk:") && a.patientId ? [[a.ref, a.patientId] as const] : []))),
    prescriptionRefs: new Set(rx.map((r) => r.ref).filter((x): x is string => !!x)),
    documentHashes: new Set(docs.map((d) => `${d.patientId}|${d.sha}`)),
    therapists: members.filter((m) => hasOwnCalendar(m.role)).map((m) => ({ id: m.id, name: m.name, color: m.color })),
    locations,
    services,
  };
}

export interface ApplySummary {
  patientsCreated: number;
  patientsLinked: number;
  appointments: number;
  prescriptions: number;
  documents: number;
  /** neu angelegte Leistungen (Pododesk) */
  services: number;
  /** Kalenderfarben für Teammitglieder ohne eigene Farbe (Pododesk) */
  therapistColors: number;
  excel: Pick<PersistSummary, "patients" | "services" | "vouchers" | "invoices" | "payments" | "fixedCosts"> | null;
}

/** Bestandspersonen aus dem Plan (existingId), an die Termine/Verordnungen/Dokumente geschrieben werden dürfen (H3). */
async function usableExistingIds(tx: Tx, org: string, plan: ImportPlan, linked: Set<string>): Promise<Set<string>> {
  const refs = [...plan.appointments.map((a) => a.patient), ...plan.prescriptions.map((p) => p.patient), ...plan.documents.map((d) => d.patient)];
  const ids = [...new Set(refs.flatMap((r) => ("existingId" in r ? [r.existingId] : [])))];
  /** Personen mit Verknüpfung im Plan: nur, wenn mindestens eine davon geschrieben wurde */
  const toLink = new Set(plan.patientsLink.map((l) => l.patientId));
  const out = new Set<string>();
  for (const part of chunks(ids)) {
    const rows = await tx
      .select({ id: s.patients.id })
      .from(s.patients)
      .where(and(eq(s.patients.organizationId, org), inArray(s.patients.id, part), isNull(s.patients.contactErasedAt)));
    for (const r of rows) if (!toLink.has(r.id) || linked.has(r.id)) out.add(r.id);
  }
  return out;
}

/** Ablage eines Dokuments; `sha256` erlaubt, bereits vor der Transaktion abgelegte Dateien wiederzuverwenden. */
export type StoreDocument = (data: Buffer, sha256: string) => Promise<{ storageKey: string; sha256: string; sizeBytes: number }>;

export async function applyPlan(tx: Tx, org: string, userId: string, plan: ImportPlan, storeDocument: StoreDocument): Promise<ApplySummary> {
  const summary: ApplySummary = { patientsCreated: 0, patientsLinked: 0, appointments: 0, prescriptions: 0, documents: 0, services: 0, therapistColors: 0, excel: null };
  // Patientennummern konkurrenzsicher vergeben (gleicher Lock wie Neuanlage, Doctolib- und Excel-Import)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);

  // ───── Patient:innen ─────
  // Neue Personen aus Tinana/Doctolib VOR der Excel-Übernahme anlegen: Excel-Zeilen ohne Legacy-ID erkennt persistImport
  // dann über Name + Geburtsdatum wieder (wie in der Vorschau gezählt). Nummern hinter den Excel-Legacy-IDs, damit die
  // Excel-Personen ihre bisherige Nummer behalten.
  await assertPatientCapacity(tx, org, plan.patientsCreate.length);
  const [m] = await tx.select({ n: max(s.patients.number) }).from(s.patients).where(eq(s.patients.organizationId, org));
  let next = (m?.n ?? 0) + 1;
  for (const p of plan.excel?.patients ?? []) if ((legacyPatientNumber(p.legacyId) ?? 0) >= next) next = legacyPatientNumber(p.legacyId)! + 1;
  const idByRef = new Map<string, string>();
  for (const part of chunks(plan.patientsCreate)) {
    const rows = await tx
      .insert(s.patients)
      .values(part.map((c) => ({ ...c.values, organizationId: org, number: next++, preferredChannel: "none" as const })))
      .returning({ id: s.patients.id, number: s.patients.number });
    rows.forEach((r, i) => idByRef.set(part[i].ref, r.id));
    summary.patientsCreated += rows.length;
  }
  /** verknüpfte Personen zählen einmal, auch wenn sie in einem Lauf eine Tinana- UND eine Doctolib-ID bekommen */
  const linked = new Set<string>();
  for (const l of plan.patientsLink) {
    // nur ergänzen: Quell-ID setzen, wenn für diese Quelle noch keine da ist – nie an gelöschte Personen (Art. 17, H3)
    const r = await tx
      .update(s.patients)
      .set({ externalIds: sql`${s.patients.externalIds} || jsonb_build_object(${l.key}::text, ${l.externalId}::text)` })
      .where(and(eq(s.patients.organizationId, org), eq(s.patients.id, l.patientId), isNull(s.patients.contactErasedAt), sql`not (${s.patients.externalIds} ? ${l.key})`))
      .returning({ id: s.patients.id });
    for (const x of r) linked.add(x.id);
  }
  summary.patientsLinked = linked.size;

  // Bestandspersonen, an die geschrieben werden darf (AppSec H3): in dieser Praxis, nicht gelöscht – und, falls der Plan
  // sie neu verknüpfen sollte, tatsächlich verknüpft (keine Termine/Verordnungen/Dokumente an eine Person, deren
  // Verknüpfung nicht geschrieben wurde).
  const usable = await usableExistingIds(tx, org, plan, linked);

  // ───── PodoHero-Excel (bisheriger Import, hier ohne Doppelanlage) ─────
  if (plan.excel) {
    const r = await persistImport(tx, org, plan.excel, userId, { skipExisting: true });
    summary.excel = { patients: r.patients, services: r.services, vouchers: r.vouchers, invoices: r.invoices, payments: r.payments, fixedCosts: r.fixedCosts };
  }
  // ───── Leistungen (Pododesk): nur fehlende Kürzel anlegen, vorhandene nie ändern ─────
  const serviceIdByCode = new Map<string, string>();
  for (const part of chunks(plan.servicesCreate)) {
    const rows = await tx
      .insert(s.services)
      .values(part.map((sv) => ({ organizationId: org, code: sv.code, name: sv.name, priceCents: sv.priceCents, vatRate: sv.vatRate, durationMin: sv.durationMin, requiresTherapeuticPurpose: sv.vatRate === 0 })))
      .onConflictDoNothing({ target: [s.services.organizationId, s.services.code] })
      .returning({ id: s.services.id, code: s.services.code });
    for (const r of rows) serviceIdByCode.set(r.code, r.id);
    summary.services += rows.length;
  }
  const missingCodes = [...new Set(plan.appointments.flatMap((a) => a.serviceCodes ?? []))].filter((c) => !serviceIdByCode.has(c));
  for (const part of chunks(missingCodes)) {
    const rows = await tx.select({ id: s.services.id, code: s.services.code }).from(s.services).where(and(eq(s.services.organizationId, org), inArray(s.services.code, part)));
    for (const r of rows) serviceIdByCode.set(r.code, r.id);
  }

  // ───── Kalenderfarben (Pododesk): nur für Teammitglieder ohne gewählte Farbe ─────
  for (const c of plan.therapistColors) {
    if (!isTherapistColor(c.color)) continue;
    const r = await tx
      .update(s.memberships)
      .set({ color: c.color })
      .where(and(eq(s.memberships.organizationId, org), eq(s.memberships.userId, c.userId), eq(s.memberships.active, true), inArray(s.memberships.role, [...CALENDAR_ROLES]), isNull(s.memberships.color)))
      .returning({ id: s.memberships.id });
    summary.therapistColors += r.length;
  }

  const pid = (r: PatientRef): string | null => ("existingId" in r ? (usable.has(r.existingId) ? r.existingId : null) : idByRef.get(r.ref) ?? null);

  // ───── Termine ─────
  for (const part of chunks(plan.appointments)) {
    const values = part
      .map((a) => ({
        organizationId: org,
        patientId: pid(a.patient),
        therapistId: a.therapistId,
        locationId: a.locationId,
        startsAt: new Date(a.startsAt),
        endsAt: new Date(a.endsAt),
        status: a.status,
        source: "import" as const,
        externalId: a.externalId,
        title: a.title,
        notes: a.notes,
        homeVisit: a.homeVisit,
      }))
      .filter((v) => v.patientId);
    if (!values.length) continue;
    const rows = await tx
      .insert(s.appointments)
      .values(values)
      .onConflictDoNothing({ target: [s.appointments.organizationId, s.appointments.source, s.appointments.externalId] })
      .returning({ id: s.appointments.id, externalId: s.appointments.externalId });
    summary.appointments += rows.length;
    const servicesByExt = new Map(part.map((a) => [a.externalId, [...new Set([...a.serviceIds, ...(a.serviceCodes ?? []).flatMap((c) => serviceIdByCode.get(c) ?? [])])]]));
    const links = rows.flatMap((r) => (servicesByExt.get(r.externalId ?? "") ?? []).map((serviceId) => ({ organizationId: org, appointmentId: r.id, serviceId })));
    for (const lp of chunks(links)) if (lp.length) await tx.insert(s.appointmentServices).values(lp);
  }

  // ───── Verordnungen ─────
  for (const part of chunks(plan.prescriptions)) {
    const values = part
      .map((p) => ({
        organizationId: org,
        patientId: pid(p.patient)!,
        ...p.values,
        // Herkunft laut CHECK (paper|ocr|everordnung): es waren Papier-Verordnungen; die Übernahme erkennt man an
        // external_ref („tinana:…“) und rules_version („import-tinana“)
        source: "paper",
        externalRef: p.externalRef,
        rulesVersion: "import-tinana",
        createdBy: userId,
      }))
      .filter((v) => v.patientId);
    if (!values.length) continue;
    const rows = await tx.insert(s.prescriptions).values(values).onConflictDoNothing().returning({ id: s.prescriptions.id });
    summary.prescriptions += rows.length;
  }

  // ───── Dokumente (Rechnungs-PDFs aus Fremdsystemen, verschlüsselt abgelegt) ─────
  for (const d of plan.documents) {
    const patientId = pid(d.patient);
    if (!patientId) continue;
    const stored = await storeDocument(Buffer.from(d.data), d.sha256);
    await tx.insert(s.media).values({
      organizationId: org,
      patientId,
      kind: "document",
      purpose: "document",
      storageKey: stored.storageKey,
      mime: "application/pdf",
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      caption: d.caption.slice(0, 300),
      uploadedBy: userId,
    });
    summary.documents++;
  }
  return summary;
}
