"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { WEEKDAYS, parseRanges, type TimeRange } from "@/lib/availability";
import { absenceInput, addAbsence, deleteAbsence, saveWorkingHours } from "@/server/staff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamState = { error?: string; ok?: string } | undefined;

const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : "";
};

export async function saveWorkingHoursAction(_: TeamState, form: FormData): Promise<TeamState> {
  const auth = await requireAuth("users.manage");
  const userId = str(form, "userId");
  if (!UUID.test(userId)) return { error: "Person nicht gefunden." };
  const byWeekday: Record<number, TimeRange[]> = {};
  for (const [wd, label] of WEEKDAYS) {
    const r = parseRanges(str(form, `wd${wd}`).slice(0, 200));
    if (r.error) return { error: `${label}: ${r.error}` };
    byWeekday[wd] = r.ranges;
  }
  const res = await saveWorkingHours(auth, userId, byWeekday);
  if (res.error) return { error: res.error };
  revalidatePath("/team");
  return { ok: "Arbeitszeiten gespeichert." };
}

export async function addAbsenceAction(_: TeamState, form: FormData): Promise<TeamState> {
  const auth = await requireAuth("users.manage");
  const parsed = absenceInput.safeParse({
    userId: str(form, "userId"),
    kind: str(form, "kind"),
    startsOn: str(form, "startsOn"),
    endsOn: str(form, "endsOn") || str(form, "startsOn"),
    note: str(form, "note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await addAbsence(auth, parsed.data);
  if (res.error) return { error: res.error };
  revalidatePath("/team");
  return { ok: "Abwesenheit eingetragen." };
}

export async function deleteAbsenceAction(form: FormData) {
  const auth = await requireAuth("users.manage");
  const id = str(form, "id");
  if (UUID.test(id)) await deleteAbsence(auth, id);
  revalidatePath("/team");
}
