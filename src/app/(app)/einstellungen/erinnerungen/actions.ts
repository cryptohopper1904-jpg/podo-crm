"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { parseReminderSettings } from "@/lib/reminders";
import { runReminders } from "@/server/reminders";

type State = { error?: string; ok?: string } | undefined;

export async function saveReminderSettingsAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const weeks = Number(form.get("recallAfterWeeks"));
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 104) return { error: "Rückholung: bitte 2 bis 104 Wochen angeben." };
  const settings = parseReminderSettings({
    r24: form.get("r24") === "on",
    recall: form.get("recall") === "on",
    braceCheck: form.get("braceCheck") === "on",
    recallAfterWeeks: weeks,
  });
  // organizations hat keine RLS – nur die eigene Praxis (aus der Sitzung) wird geändert
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('reminders', ${JSON.stringify(settings)}::jsonb)` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.reminders", meta: settings });
  revalidatePath("/einstellungen/erinnerungen");
  return { ok: "Gespeichert." };
}

export async function runRemindersNowAction(_: State): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const r = await runReminders({ organizationId: auth.organization.id });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "reminders.run_manual", meta: { sent: r.sent, failed: r.failed } });
  revalidatePath("/einstellungen/erinnerungen");
  if (r.errors.length) return { error: "Lauf fehlgeschlagen. Bitte später erneut versuchen." };
  return { ok: `Lauf beendet: ${r.sent} gesendet, ${r.failed} fehlgeschlagen, ${r.duplicates} bereits erledigt, ${r.skipped} ohne Einwilligung/Adresse.` };
}
