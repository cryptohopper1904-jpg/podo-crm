"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CalendarFeedError } from "@/integrations/calendar-feed/fetch";
import { assertPublicUrl, UnsafeTargetError } from "@/integrations/net-guard";
import { requireAuth } from "@/lib/auth/session";
import { createCalendarFeed, deleteCalendarFeed, syncCalendarFeed, updateCalendarFeed } from "@/server/calendar-feeds";
import { normalizeFeedUrl } from "@/integrations/calendar-feed/fetch";

export type FeedState = { error?: string; ok?: string } | undefined;

const base = z.object({
  label: z.string().trim().min(1, "Bitte eine Bezeichnung eingeben.").max(80),
  therapistId: z.union([z.literal(""), z.string().uuid()]).transform((v) => (v === "" ? null : v)),
  source: z.enum(["doctolib", "extern"]),
});

const fail = (e: unknown): FeedState => {
  if (e instanceof UnsafeTargetError || e instanceof CalendarFeedError) return { error: e.message };
  throw e;
};

function revalidate() {
  revalidatePath("/einstellungen/kalender-abo");
  revalidatePath("/kalender");
  revalidatePath("/heute");
}

/** Prüft die Adresse (https, öffentlich auflösbar) – der eigentliche Abruf folgt per „Jetzt abrufen“ bzw. Cron. */
async function checkUrl(raw: string) {
  await assertPublicUrl(normalizeFeedUrl(raw));
}

export async function createFeedAction(_: FeedState, form: FormData): Promise<FeedState> {
  const auth = await requireAuth("integrations.manage");
  const parsed = base.extend({ url: z.string().trim().min(1, "Bitte die iCal-Adresse eingeben.").max(2000) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  if (form.get("avv") !== "on") return { error: "Bitte bestätigen Sie den Datenschutz-Hinweis (AVV)." };
  let id: string;
  try {
    await checkUrl(parsed.data.url);
    id = await createCalendarFeed(auth, parsed.data);
  } catch (e) {
    return fail(e);
  }
  const r = await syncCalendarFeed(auth.organization.id, id, { userId: auth.user.id });
  revalidate();
  if ("error" in r) return { ok: `Kalender-Abo gespeichert. Erster Abruf fehlgeschlagen: ${r.error}` };
  return { ok: `Kalender-Abo gespeichert: ${r.created} Termine übernommen.` };
}

export async function updateFeedAction(_: FeedState, form: FormData): Promise<FeedState> {
  const auth = await requireAuth("integrations.manage");
  const id = z.string().uuid().safeParse(form.get("id"));
  const parsed = base.extend({ url: z.string().trim().max(2000).optional() }).safeParse(Object.fromEntries(form));
  if (!id.success || !parsed.success) return { error: parsed.success ? "Ungültige Eingabe." : parsed.error.issues[0]?.message };
  try {
    if (parsed.data.url) await checkUrl(parsed.data.url);
    await updateCalendarFeed(auth, id.data, { ...parsed.data, url: parsed.data.url || null, active: form.get("active") === "on" });
  } catch (e) {
    return fail(e);
  }
  revalidate();
  return { ok: "Gespeichert." };
}

export async function syncFeedNowAction(_: FeedState, form: FormData): Promise<FeedState> {
  const auth = await requireAuth("integrations.manage");
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Ungültige Eingabe." };
  const r = await syncCalendarFeed(auth.organization.id, id.data, { userId: auth.user.id });
  revalidate();
  if ("error" in r) return { error: r.error };
  if (r.notModified) return { ok: "Keine Änderungen seit dem letzten Abruf." };
  return {
    ok: `${r.events} Einträge gelesen: ${r.created} neu, ${r.updated} geändert, ${r.cancelled} abgesagt${r.localChanges ? `, ${r.localChanges} in PodoHero geändert (nicht überschrieben)` : ""}${r.overlaps ? `, ${r.overlaps} Überschneidungen` : ""}${r.warnings.rruleSkipped ? `, ${r.warnings.rruleSkipped} Serien übersprungen` : ""}.`,
  };
}

export async function deleteFeedAction(_: FeedState, form: FormData): Promise<FeedState> {
  const auth = await requireAuth("integrations.manage");
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Ungültige Eingabe." };
  if (form.get("confirm") !== "on") return { error: "Bitte das Entfernen bestätigen." };
  const r = await deleteCalendarFeed(auth, id.data);
  revalidate();
  return { ok: `Kalender-Abo entfernt${r.cancelled ? `, ${r.cancelled} künftige Termine abgesagt` : ""}.` };
}
