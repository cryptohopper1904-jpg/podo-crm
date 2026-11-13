"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { isViewLevel, VIEW_LEVEL_LABELS } from "@/lib/view-level";
import { saveViewLevel } from "@/server/view-level";

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
