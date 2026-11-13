"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { createBlock, deleteBlock, updateBlock } from "@/server/calendar-blocks";

export type BlockFormState = { error?: string } | undefined;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : "";
};

/** Formular → Eingabe für blockInput (Prüfung in src/lib/calendar-blocks.ts) */
function inputFrom(form: FormData) {
  const person = str(form, "userId");
  return {
    userId: person === "praxis" ? null : person,
    kind: str(form, "kind"),
    title: str(form, "title"),
    startsOn: str(form, "startsOn"),
    endsOn: str(form, "endsOn"),
    allDay: form.get("allDay") === "1",
    startTime: str(form, "startTime"),
    endTime: str(form, "endTime"),
    repeat: str(form, "repeat") || "none",
    weekdays: form.getAll("weekday").map((v) => Number(v)),
    intervalWeeks: Number(str(form, "intervalWeeks") || "1"),
    note: str(form, "note"),
  };
}

function done(dateIso: string): never {
  revalidatePath("/kalender");
  revalidatePath("/heute");
  redirect(isoDate.test(dateIso) ? `/kalender?datum=${dateIso}` : "/kalender");
}

/** Sperrzeit anlegen (Pause, Schulung, früher Feierabend, Wartung, Reinigung …). */
export async function createBlockAction(_: BlockFormState, form: FormData): Promise<BlockFormState> {
  const auth = await requireAuth("appointments.write");
  const input = inputFrom(form);
  const res = await createBlock(auth, input);
  if (!res.ok) return { error: res.error };
  done(input.startsOn);
}

/** Sperrzeit ändern – bei Serien nur dieses Vorkommen oder die ganze Serie. */
export async function updateBlockAction(_: BlockFormState, form: FormData): Promise<BlockFormState> {
  const auth = await requireAuth("appointments.write");
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Sperrzeit nicht gefunden." };
  const scope = form.get("scope") === "occurrence" ? "occurrence" : "series";
  const occurrence = str(form, "occurrence");
  const input = inputFrom(form);
  const res = await updateBlock(auth, id.data, input, scope, isoDate.test(occurrence) ? occurrence : null);
  if (!res.ok) return { error: res.error };
  revalidatePath(`/kalender/sperrzeit/${id.data}`);
  done(input.startsOn);
}

/** Sperrzeit löschen – bei Serien nur dieses Vorkommen oder die ganze Serie. */
export async function deleteBlockAction(_: BlockFormState, form: FormData): Promise<BlockFormState> {
  const auth = await requireAuth("appointments.write");
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Sperrzeit nicht gefunden." };
  const scope = form.get("scope") === "occurrence" ? "occurrence" : "series";
  const occurrence = str(form, "occurrence");
  const res = await deleteBlock(auth, id.data, scope, isoDate.test(occurrence) ? occurrence : null);
  if (!res.ok) return { error: res.error };
  done(occurrence);
}
