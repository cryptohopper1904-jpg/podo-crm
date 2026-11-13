"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { MAX_BUNDLE_BYTES } from "@/lib/everordnung/parse";
import { importEverordnung, previewEverordnung, type EverordnungPreview } from "@/server/everordnung";

export type PreviewState = { error?: string; preview?: EverordnungPreview; bundle?: string } | undefined;
export type ImportState = { error?: string } | undefined;

async function bundleText(form: FormData): Promise<string | { error: string }> {
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BUNDLE_BYTES) return { error: "Datei ist größer als 1 MB." };
    return file.text();
  }
  const pasted = String(form.get("text") ?? "").trim();
  if (!pasted) return { error: "Bitte eine Datei wählen oder den Inhalt einfügen." };
  if (Buffer.byteLength(pasted, "utf8") > MAX_BUNDLE_BYTES) return { error: "Inhalt ist größer als 1 MB." };
  return pasted;
}

export async function previewEverordnungAction(_: PreviewState, form: FormData): Promise<PreviewState> {
  const auth = await requireAuth("medical.write");
  const text = await bundleText(form);
  if (typeof text !== "string") return text;
  const res = await previewEverordnung(auth, text);
  if ("error" in res) return { error: res.error };
  return { preview: res, bundle: text };
}

const choiceSchema = z.object({
  patient: z.string().max(60),
  patientNumber: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().positive().optional()),
  diagnosisGroup: z.string().max(5).optional(),
  units: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1).max(99).optional()),
  issuedAt: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
});

export async function importEverordnungAction(_: ImportState, form: FormData): Promise<ImportState> {
  const auth = await requireAuth("medical.write");
  const text = String(form.get("bundle") ?? "");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_BUNDLE_BYTES) return { error: "Vorschau abgelaufen – bitte die Datei erneut laden." };
  const c = choiceSchema.safeParse({
    patient: form.get("patient") ?? "",
    patientNumber: form.get("patientNumber"),
    diagnosisGroup: form.get("diagnosisGroup") ?? undefined,
    units: form.get("units"),
    issuedAt: form.get("issuedAt"),
  });
  if (!c.success) return { error: "Eingaben prüfen (Einheiten 1–99, Datum)." };
  const { patient } = c.data;
  if (patient === "new" && !auth.can("patients.write")) return { error: "Keine Berechtigung, Patienten anzulegen." };
  const choice =
    patient === "new"
      ? { createPatient: true }
      : patient === "number"
        ? { patientNumber: c.data.patientNumber }
        : z.string().uuid().safeParse(patient).success
          ? { patientId: patient }
          : null;
  if (!choice || (patient === "number" && !c.data.patientNumber)) return { error: "Bitte eine Person auswählen, eine Patientennummer angeben oder neu anlegen." };
  const res = await importEverordnung(auth, text, { ...choice, diagnosisGroup: c.data.diagnosisGroup, units: c.data.units, issuedAt: c.data.issuedAt });
  if ("error" in res) return { error: res.error };
  revalidatePath("/verordnungen");
  revalidatePath(`/kunden/${res.patientId}/verordnungen`);
  const w = res.warnings.length ? `&hinweise=${encodeURIComponent(res.warnings.slice(0, 8).join("\n"))}` : "";
  redirect(`/kunden/${res.patientId}/verordnungen?gespeichert=${res.id}${w}`);
}
