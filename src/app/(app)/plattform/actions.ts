"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { isPlanId } from "@/lib/plans";
import { extendTrial, requirePlatformAdmin, setPracticePlan, setVoiceAddon, setWebsiteAddon } from "@/server/platform";
import { enterSupport, exitSupport } from "@/server/support";

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
