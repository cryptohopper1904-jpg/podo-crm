"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { runRemindersForPractice, saveReminderSettings } from "@/server/reminders";

type State = { error?: string; ok?: string } | undefined;

export async function saveReminderSettingsAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const weeks = Number(form.get("recallAfterWeeks"));
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 104) return { error: "Rückholung: bitte 2 bis 104 Wochen angeben." };
  await saveReminderSettings(auth, {
    r24: form.get("r24") === "on",
    recall: form.get("recall") === "on",
    braceCheck: form.get("braceCheck") === "on",
    recallAfterWeeks: weeks,
  });
  revalidatePath("/einstellungen/erinnerungen");
  return { ok: "Gespeichert." };
}

export async function runRemindersNowAction(): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const r = await runRemindersForPractice(auth);
  revalidatePath("/einstellungen/erinnerungen");
  if (r.errors.length) return { error: "Lauf fehlgeschlagen. Bitte später erneut versuchen." };
  return { ok: `Lauf beendet: ${r.sent} gesendet, ${r.failed} fehlgeschlagen, ${r.duplicates} bereits erledigt, ${r.skipped} ohne Einwilligung/Adresse.` };
}
