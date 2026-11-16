"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { isSlotStep, SLOT_STEP_LABELS } from "@/lib/calendar-grid";
import { canSetCalendarSlot, saveCalendarSlot } from "@/server/calendar-board";

export type CalendarSettingsState = { error?: string; ok?: string } | undefined;

/** Raster der Zeitachse – persönliche Einstellung (wer den Kalender sieht); im Support-Modus nicht speicherbar. */
export async function saveCalendarSlotAction(_: CalendarSettingsState, form: FormData): Promise<CalendarSettingsState> {
  const auth = await requireAuth("appointments.read");
  if (!canSetCalendarSlot(auth)) return { error: "Im Support-Modus nicht änderbar." };
  const step = Number(form.get("slotMin"));
  if (!isSlotStep(step)) return { error: "Bitte ein Raster wählen." };
  await saveCalendarSlot(auth.user.id, step);
  revalidatePath("/kalender");
  revalidatePath("/einstellungen/kalender");
  return { ok: `Raster „${SLOT_STEP_LABELS[step].replace(" (Standard)", "")}“ gespeichert.` };
}
