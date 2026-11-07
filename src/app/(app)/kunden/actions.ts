"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { consents, patients } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { findDuplicates, nextPatientNumber, patientInput, toPatientValues } from "@/server/patients";

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
    const number = await nextPatientNumber(org);
    const [row] = await withOrg(org, (tx) => tx.insert(patients).values({ ...values, organizationId: org, number, source: "manual" }).returning({ id: patients.id }));
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
