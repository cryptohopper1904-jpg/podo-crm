"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { assignResident, careHomeInput, isResident, removeResident, saveCareHome } from "@/server/care-homes";
import { createTreatmentRecord } from "@/server/records";

type State = { error?: string; ok?: string } | undefined;

export async function saveCareHomeAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("patients.write");
  const parsed = careHomeInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const id = await saveCareHome(auth, parsed.data);
  if (!id) return { error: "Pflegeheim nicht gefunden." };
  revalidatePath("/pflegeheime");
  if (!parsed.data.id) redirect(`/pflegeheime/${id}`);
  revalidatePath(`/pflegeheime/${id}`);
  return { ok: "Gespeichert." };
}

export async function assignResidentAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("patients.write");
  const careHomeId = z.string().uuid().safeParse(form.get("careHomeId"));
  const patientId = z.string().uuid().safeParse(form.get("patientId"));
  if (!careHomeId.success) return { error: "Ungültige Anfrage." };
  if (!patientId.success) return { error: "Bitte einen Patienten auswählen." };
  const ok = await assignResident(auth, { careHomeId: careHomeId.data, patientId: patientId.data, billToHome: form.get("billToHome") === "on" });
  if (!ok) return { error: "Zuordnung nicht möglich." };
  revalidatePath(`/pflegeheime/${careHomeId.data}`);
  revalidatePath("/pflegeheime");
  return { ok: "Bewohner:in zugeordnet." };
}

export async function removeResidentAction(form: FormData) {
  const auth = await requireAuth("patients.write");
  const careHomeId = z.string().uuid().parse(form.get("careHomeId"));
  const patientId = z.string().uuid().parse(form.get("patientId"));
  await removeResident(auth, { careHomeId, patientId });
  revalidatePath(`/pflegeheime/${careHomeId}`);
  revalidatePath("/pflegeheime");
}

export type QuickRecordState = { error?: string; ok?: string } | undefined;

const quickSchema = z.object({
  careHomeId: z.string().uuid(),
  patientId: z.string().uuid(),
  servicesText: z.string().trim().max(1000).optional().transform((v) => v || null),
  findings: z.string().trim().max(2000).optional().transform((v) => v || null),
  prescriptionId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid().optional()),
  confirm: z.literal("on", { message: "Bitte die Prüfung bestätigen." }),
});

/** Listen-Doku am Besuchstag: ein Eintrag je Bewohner:in, gleiche Hash-Kette wie die Einzel-Doku. */
export async function quickRecordAction(_: QuickRecordState, form: FormData): Promise<QuickRecordState> {
  const auth = await requireAuth("medical.write");
  const parsed = quickSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  if (!d.servicesText && !d.findings) return { error: "Bitte Leistung oder Befund eintragen." };
  if (!(await isResident(auth, d.careHomeId, d.patientId))) return { error: "Patient wohnt nicht in diesem Pflegeheim." };
  const res = await createTreatmentRecord(
    auth,
    { patientId: d.patientId, prescriptionId: d.prescriptionId ?? null, servicesText: d.servicesText, findings: d.findings, structured: { mode: "care_home", careHomeId: d.careHomeId } },
    { mode: "care_home" },
  );
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${d.patientId}`);
  return { ok: "Gespeichert" };
}
