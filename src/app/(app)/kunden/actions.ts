"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq, max, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { consents, patients } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { deletePatient, erasePatientContact, PatientDeletionError } from "@/server/patient-deletion";
import { findDuplicates, patientInput, toPatientValues } from "@/server/patients";

export type PatientFormState = { error?: string; duplicates?: { id: string; number: number; name: string }[] } | undefined;

function parseBirthDate(raw: FormDataEntryValue | null) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

export async function savePatientAction(_: PatientFormState, form: FormData): Promise<PatientFormState> {
  const auth = await requireAuth("patients.write");
  const raw = Object.fromEntries(form);
  raw.birthDate = parseBirthDate(form.get("birthDate"));
  const parsed = patientInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const id = String(form.get("id") ?? "") || null;
  const org = auth.organization.id;
  const values = toPatientValues(parsed.data);

  if (!id && form.get("ignoreDuplicates") !== "1") {
    const dups = await findDuplicates(org, values);
    if (dups.length) {
      return {
        error: "Möglicherweise gibt es diese Person schon. Bitte prüfen oder trotzdem anlegen.",
        duplicates: dups.map((d) => ({ id: d.id, number: d.number, name: [d.firstName, d.lastName].filter(Boolean).join(" ") })),
      };
    }
  }

  let savedId = id;
  if (id) {
    await withOrg(org, (tx) =>
      tx.update(patients).set({ ...values, updatedAt: new Date() }).where(and(eq(patients.organizationId, org), eq(patients.id, id))),
    );
    await audit({ organizationId: org, userId: auth.user.id, action: "patient.update", entity: "patient", entityId: id });
  } else {
    const [row] = await withOrg(org, async (tx) => {
      // Patientennummern lückenlos und ohne Kollision vergeben (gleiche Sperre wie Import/Buchung)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);
      const [m] = await tx.select({ n: max(patients.number) }).from(patients).where(eq(patients.organizationId, org));
      return tx.insert(patients).values({ ...values, organizationId: org, number: (m?.n ?? 0) + 1, source: "manual" }).returning({ id: patients.id });
    });
    savedId = row.id;
    await audit({ organizationId: org, userId: auth.user.id, action: "patient.create", entity: "patient", entityId: row.id });
  }
  revalidatePath("/kunden");
  redirect(`/kunden/${savedId}`);
}

export async function recordConsentAction(form: FormData) {
  const auth = await requireAuth("patients.write");
  const org = auth.organization.id;
  const patientId = String(form.get("patientId"));
  const type = String(form.get("type")) as (typeof consents.$inferInsert)["type"];
  const granted = form.get("granted") === "1";
  await withOrg(org, (tx) =>
    tx.insert(consents).values({ organizationId: org, patientId, type, granted, via: String(form.get("via") ?? "praxis"), recordedBy: auth.user.id }),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "consent.record", entity: "patient", entityId: patientId, meta: { type, granted } });
  revalidatePath(`/kunden/${patientId}`);
}

export async function archivePatientAction(form: FormData) {
  const auth = await requireAuth("patients.write");
  const org = auth.organization.id;
  const id = String(form.get("id"));
  // Archivieren statt Löschen: Aufbewahrungspflicht 10 Jahre (§ 630f BGB)
  await withOrg(org, (tx) => tx.update(patients).set({ archivedAt: new Date() }).where(and(eq(patients.organizationId, org), eq(patients.id, id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.archive", entity: "patient", entityId: id });
  redirect("/kunden");
}

export type DeletionState = { error?: string; ok?: string } | undefined;

/** Patient:in vollständig löschen (Gesamt-Review H3) – nur ohne aufbewahrungspflichtige Daten, Bestätigung per Patientennummer. */
export async function deletePatientAction(_: DeletionState, form: FormData): Promise<DeletionState> {
  const auth = await requireAuth("users.manage");
  const id = String(form.get("id") ?? "");
  const [p] = await withOrg(auth.organization.id, (tx) =>
    tx.select({ number: patients.number }).from(patients).where(and(eq(patients.organizationId, auth.organization.id), eq(patients.id, id))),
  );
  if (!p) return { error: "Patient:in nicht gefunden." };
  if (String(form.get("confirm") ?? "").trim().replace(/^#/, "") !== String(p.number)) return { error: `Zur Bestätigung bitte die Patientennummer ${p.number} eintragen.` };
  try {
    await deletePatient(auth, id);
  } catch (e) {
    if (e instanceof PatientDeletionError) return { error: e.message };
    throw e;
  }
  revalidatePath("/kunden");
  redirect("/kunden");
}

/** Kontaktdaten löschen und Marketing widerrufen, wenn die Akte aufbewahrt werden muss (Gesamt-Review H3). */
export async function erasePatientContactAction(_: DeletionState, form: FormData): Promise<DeletionState> {
  const auth = await requireAuth("users.manage");
  const id = String(form.get("id") ?? "");
  if (form.get("confirm") !== "on") return { error: "Bitte bestätigen." };
  try {
    const r = await erasePatientContact(auth, id);
    revalidatePath(`/kunden/${id}`);
    return { ok: `Kontaktdaten gelöscht, ${r.revoked} Einwilligung(en) widerrufen, ${r.photos} Marketing-Foto(s) gelöscht. Die Akte bleibt bis zum Fristende archiviert.` };
  } catch (e) {
    if (e instanceof PatientDeletionError) return { error: e.message };
    throw e;
  }
}
