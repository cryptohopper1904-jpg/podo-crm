"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { isViewLevel, VIEW_LEVEL_LABELS } from "@/lib/view-level";
import { saveViewLevel } from "@/server/view-level";
import { setTherapistColor } from "@/server/therapist-colors";

export type ViewLevelState = { error?: string; ok?: string } | undefined;

/** Persönliche Einstellung – kein Praxis-Recht nötig (requireAuth() ohne Recht; im Support-Modus abgelehnt). */
async function save(level: unknown): Promise<ViewLevelState> {
  const auth = await requireAuth();
  if (!isViewLevel(level)) return { error: "Bitte eine Ansicht wählen." };
  if (!(await saveViewLevel(auth.user.id, level))) return { error: "Konnte nicht gespeichert werden." };
  revalidatePath("/", "layout"); // Navigation (Layout) und Startseite neu aufbauen
  return { ok: `Ansicht „${VIEW_LEVEL_LABELS[level]}“ gespeichert.` };
}

/** Formular unter Einstellungen → Ansicht */
export async function saveViewLevelAction(_: ViewLevelState, form: FormData): Promise<ViewLevelState> {
  return save(form.get("level"));
}

/** Schnellumschalter in der linken Navigation */
export async function setViewLevelAction(level: string): Promise<ViewLevelState> {
  return save(level);
}

/**
 * Kalenderfarbe einer Behandler:in (Einstellungen → Ansicht: eigene; Einstellungen → Team: alle mit Teamverwaltung).
 * Rechte prüft setTherapistColor (eigene Farbe oder users.manage, nie im Support-Modus).
 */
export async function saveCalendarColorAction(_: ViewLevelState, form: FormData): Promise<ViewLevelState> {
  const auth = await requireAuth();
  const userId = form.get("userId");
  const color = form.get("color");
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) return { error: "Person nicht gefunden." };
  if (userId !== auth.user.id && !auth.can("users.manage")) return { error: "Keine Berechtigung für die Farbe anderer Personen." };
  const res = await setTherapistColor(auth, userId, typeof color === "string" && color ? color : null);
  if (!res.ok) return { error: res.error };
  revalidatePath("/kalender");
  revalidatePath("/einstellungen/team");
  revalidatePath("/einstellungen/ansicht");
  return { ok: "Kalenderfarbe gespeichert." };
}
