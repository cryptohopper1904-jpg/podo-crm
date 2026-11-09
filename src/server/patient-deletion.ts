import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { anamneses, consents, invoices, media, patientLinks, patients, treatmentRecords, waitlist } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { ERASABLE_CONSENTS, retentionDecision, type RetentionDecision, type RetentionFacts } from "@/lib/patient-retention";
import { discardStored } from "@/lib/storage";

/**
 * „Kund:in löschen“ (Gesamt-Review H3, Art. 17 DSGVO) – nur Inhaber:in, nie im Support-Modus.
 * - Ohne aufbewahrungspflichtige Daten: vollständige Löschung über die DB-Funktion podo_delete_patient
 *   (prüft die Fristen-Daten selbst noch einmal, löscht Einwilligungen/Medien ohne Behandlungsbezug mit).
 * - Mit Dokumentation/Rechnungen: Löschung gesperrt; angeboten wird das Löschen der Kontaktdaten,
 *   Widerruf aller Marketing-/Kanal-Einwilligungen, Löschen der Marketing-Fotos und Archivierung.
 */
export class PatientDeletionError extends Error {}

function assertOwner(auth: AuthContext) {
  if (auth.support || auth.role !== "owner") throw new PatientDeletionError("Nur Inhaber:innen können Kund:innen löschen.");
}

export async function retentionFacts(org: string, patientId: string): Promise<(RetentionFacts & { number: number; contactErasedAt: Date | null }) | null> {
  return withOrg(org, async (tx) => {
    const [p] = await tx.select({ number: patients.number, contactErasedAt: patients.contactErasedAt }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const [r] = await tx.select({ at: max(treatmentRecords.treatedAt) }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.patientId, patientId)));
    const [a] = await tx.select({ at: max(anamneses.createdAt) }).from(anamneses).where(and(eq(anamneses.organizationId, org), eq(anamneses.patientId, patientId)));
    const [m] = await tx.select({ n: count() }).from(media).where(and(eq(media.organizationId, org), eq(media.patientId, patientId), isNotNull(media.recordId)));
    const [i] = await tx
      .select({ at: sql<string | null>`max(coalesce(${invoices.issuedAt}::timestamptz, ${invoices.createdAt}))` })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.patientId, patientId)));
    return {
      number: p.number,
      contactErasedAt: p.contactErasedAt,
      lastTreatmentAt: r?.at ?? null,
      lastAnamnesisAt: a?.at ?? null,
      recordMediaCount: Number(m?.n ?? 0),
      lastInvoiceAt: i?.at ? new Date(i.at) : null,
    };
  });
}

export async function deletionStatus(auth: AuthContext, patientId: string): Promise<(RetentionDecision & { contactErasedAt: Date | null }) | null> {
  const f = await retentionFacts(auth.organization.id, patientId);
  return f ? { ...retentionDecision(f), contactErasedAt: f.contactErasedAt } : null;
}

/** Vollständige Löschung – nur ohne aufbewahrungspflichtige Daten. */
export async function deletePatient(auth: AuthContext, patientId: string): Promise<void> {
  assertOwner(auth);
  const org = auth.organization.id;
  const facts = await retentionFacts(org, patientId);
  if (!facts) throw new PatientDeletionError("Kund:in nicht gefunden.");
  if (retentionDecision(facts).mode !== "delete") throw new PatientDeletionError("Es gibt aufbewahrungspflichtige Unterlagen – nur die Kontaktdaten können gelöscht werden.");
  const keys = await withOrg(org, async (tx) => {
    const files = await tx.select({ key: media.storageKey }).from(media).where(and(eq(media.organizationId, org), eq(media.patientId, patientId)));
    // Die DB-Funktion prüft die Aufbewahrung im selben Snapshot erneut (keine Lücke zwischen Prüfung und Löschung)
    const r = await tx.execute(sql`select podo_delete_patient(${patientId}::uuid) as ok`);
    if (!(r.rows[0] as { ok?: boolean } | undefined)?.ok) throw new PatientDeletionError("Kund:in nicht gefunden.");
    return files.map((f) => f.key);
  });
  for (const k of keys) await discardStored(k).catch(() => undefined);
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.deleted", entity: "patient", entityId: patientId, meta: { number: facts.number, files: keys.length } });
}

/** Kontaktdaten löschen, Marketing widerrufen, Marketing-Fotos löschen, archivieren – Akte bleibt bis Fristende. */
export async function erasePatientContact(auth: AuthContext, patientId: string): Promise<{ revoked: number; photos: number }> {
  assertOwner(auth);
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId))).for("update");
    if (!p) return null;
    await tx
      .update(patients)
      .set({
        phoneMobile: null,
        phoneLandline: null,
        email: null,
        street: null,
        preferredChannel: "none",
        visitIntervalWeeks: null,
        notes: null,
        extra: {},
        archivedAt: sql`coalesce(${patients.archivedAt}, now())`,
        contactErasedAt: new Date(),
      })
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    // Letzter Stand je Einwilligungsart: erteilte werden widerrufen (append-only → neuer Eintrag)
    const rows = await tx
      .select({ type: consents.type, granted: consents.granted })
      .from(consents)
      .where(and(eq(consents.organizationId, org), eq(consents.patientId, patientId), inArray(consents.type, [...ERASABLE_CONSENTS])))
      .orderBy(desc(consents.recordedAt));
    const latest = new Map<string, boolean>();
    for (const r of rows) if (!latest.has(r.type)) latest.set(r.type, r.granted);
    const revoke = [...latest].filter(([, g]) => g).map(([t]) => t as (typeof ERASABLE_CONSENTS)[number]);
    if (revoke.length) {
      await tx.insert(consents).values(revoke.map((type) => ({ organizationId: org, patientId, type, granted: false, via: "loeschung", recordedBy: auth.user.id })));
    }
    // Marketing-Fotos sind keine Dokumentation → Datei löschen, Eintrag als gelöscht markieren
    const photos = await tx
      .update(media)
      .set({ deletedAt: new Date() })
      .where(and(eq(media.organizationId, org), eq(media.patientId, patientId), eq(media.purpose, "marketing"), isNull(media.recordId), isNull(media.deletedAt)))
      .returning({ key: media.storageKey });
    await tx.delete(patientLinks).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId)));
    await tx.delete(waitlist).where(and(eq(waitlist.organizationId, org), eq(waitlist.patientId, patientId)));
    return { revoked: revoke.length, keys: photos.map((x) => x.key) };
  });
  if (!res) throw new PatientDeletionError("Kund:in nicht gefunden.");
  for (const k of res.keys) await discardStored(k).catch(() => undefined);
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.contact_erased", entity: "patient", entityId: patientId, meta: { revokedConsents: res.revoked, marketingPhotos: res.keys.length } });
  return { revoked: res.revoked, photos: res.keys.length };
}
