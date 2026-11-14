"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { isPlanId } from "@/lib/plans";
import { extendTrial, requirePlatformAdmin, setPracticePlan, setVoiceAddon, setWebsiteAddon } from "@/server/platform";
import { enterSupport, exitSupport } from "@/server/support";
import { ManualNoticeError, recordManualNotice } from "@/server/readonly-expiry";
import { MANUAL_NOTICE_VIAS, type ManualNoticeVia } from "@/lib/readonly-expiry";

export async function setPlanAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ organizationId: z.string().uuid(), plan: z.string(), seats: z.coerce.number().int().min(1).max(999) }).safeParse(Object.fromEntries(form));
  if (!d.success || !isPlanId(d.data.plan)) redirect("/plattform?fehler=eingabe");
  await setPracticePlan(row.user.id, d.data.organizationId, d.data.plan, d.data.seats);
  revalidatePath("/plattform");
}

export async function extendTrialAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ organizationId: z.string().uuid(), days: z.coerce.number().int().min(1).max(90) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect("/plattform?fehler=eingabe");
  await extendTrial(row.user.id, d.data.organizationId, d.data.days);
  revalidatePath("/plattform");
}

export async function setVoiceAddonAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ organizationId: z.string().uuid(), on: z.enum(["0", "1"]) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect("/plattform?fehler=eingabe");
  await setVoiceAddon(row.user.id, d.data.organizationId, d.data.on === "1");
  revalidatePath("/plattform");
}

export async function setWebsiteAddonAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ organizationId: z.string().uuid(), on: z.enum(["0", "1"]) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect("/plattform?fehler=eingabe");
  await setWebsiteAddon(row.user.id, d.data.organizationId, d.data.on === "1");
  revalidatePath("/plattform");
}

export type ManualNoticeState = { error?: string; ok?: string } | undefined;

/**
 * Pflichtaktion „Ankündigung in Textform von Hand verschickt“ (Ende des Nur-Lesen-Modus, E-Mail nicht zugestellt):
 * nur Plattform-Admin mit 2FA; Audit platform.readonly_notice_manual an der Praxis.
 */
export async function recordManualNoticeAction(_: ManualNoticeState, form: FormData): Promise<ManualNoticeState> {
  const row = await requirePlatformAdmin();
  const d = z
    .object({
      organizationId: z.string().uuid(),
      receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      via: z.string().refine((v): v is ManualNoticeVia => Object.hasOwn(MANUAL_NOTICE_VIAS, v)),
      note: z.string().max(300),
      confirm: z.literal("on"),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: "Bitte Datum, Weg und Nachweis angeben und die Ankündigung bestätigen." };
  try {
    const r = await recordManualNotice(row.user.id, d.data.organizationId, { receivedOn: d.data.receivedOn, via: d.data.via as ManualNoticeVia, note: d.data.note });
    revalidatePath("/plattform");
    return { ok: `Vermerkt. Angekündigter Löschtermin: ${r.deletionAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}.` };
  } catch (e) {
    if (e instanceof ManualNoticeError) return { error: e.message };
    throw e;
  }
}

/** Support-Zugriff starten – nur mit gültiger Freigabe der Praxis (sonst kein Zutritt). */
export async function enterSupportAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const id = z.string().uuid().safeParse(form.get("organizationId"));
  if (!id.success) redirect("/plattform?fehler=eingabe");
  const ok = await enterSupport(row.user, row.session.id, id.data);
  if (!ok) redirect("/plattform?fehler=keine-freigabe");
  redirect("/heute");
}

/** Support-Modus verlassen (auch nach Ablauf der Freigabe möglich). */
export async function exitSupportAction() {
  const row = await getSession();
  if (!row || !row.session.verified) redirect("/login");
  if (!(await exitSupport(row.user.id, row.session.id, row.session.organizationId))) redirect("/login");
  redirect(row.user.isPlatformAdmin && row.user.totpEnabled ? "/plattform" : "/heute");
}
