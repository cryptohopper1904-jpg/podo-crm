"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { organizations, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { isOnboardingKey, nextStep, type OnboardingKey } from "@/lib/onboarding";
import { isTemplateId, SERVICE_TEMPLATES } from "@/lib/service-templates";

export type WelcomeState = { error?: string; ok?: string } | undefined;

async function ownerAuth() {
  const auth = await requireAuth("settings.manage");
  if (auth.role !== "owner" || auth.support) redirect("/kein-zugriff");
  return auth;
}

async function markDone(orgId: string, key: OnboardingKey) {
  await db
    .update(organizations)
    .set({ onboarding: sql`${organizations.onboarding} || ${JSON.stringify({ [key]: true })}::jsonb` })
    .where(eq(organizations.id, orgId));
}

const goNext = (key: OnboardingKey): never => {
  revalidatePath("/heute");
  redirect(`/willkommen?schritt=${nextStep(key).slug}`);
};

const opt = z.string().trim().max(300).optional().transform((v) => v || null);

export async function savePracticeStepAction(_: WelcomeState, form: FormData): Promise<WelcomeState> {
  const auth = await ownerAuth();
  const d = z
    .object({
      name: z.string().trim().min(2, "Bitte den Praxisnamen angeben.").max(200),
      street: opt, zip: opt, city: opt, phone: opt, email: opt, taxNumber: opt,
      state: z.string().length(2),
      smallBusiness: z.string().optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben prüfen." };
  const { smallBusiness, ...rest } = d.data;
  await db.update(organizations).set({ ...rest, smallBusiness: smallBusiness === "on" }).where(eq(organizations.id, auth.organization.id));
  await markDone(auth.organization.id, "practice");
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "onboarding.practice" });
  return goNext("practice");
}

export async function applyServiceTemplateAction(_: WelcomeState, form: FormData): Promise<WelcomeState> {
  const auth = await ownerAuth();
  const tpl = form.get("template");
  if (!isTemplateId(tpl)) return { error: "Bitte eine Vorlage wählen." };
  const org = auth.organization.id;
  const rows = SERVICE_TEMPLATES[tpl].services();
  // Vorhandene Kürzel bleiben unverändert (keine Überschreibung eigener Preise)
  await withOrg(org, (tx) =>
    tx
      .insert(services)
      .values(rows.map((s) => ({ ...s, organizationId: org })))
      .onConflictDoNothing({ target: [services.organizationId, services.code] }),
  );
  await markDone(org, "services");
  await audit({ organizationId: org, userId: auth.user.id, action: "onboarding.services", meta: { template: tpl } });
  return goNext("services");
}

/** Schritte ohne eigenes Formular (Team, Import, Schnittstellen, Fertig) abhaken bzw. überspringen. */
export async function completeStepAction(form: FormData) {
  const auth = await ownerAuth();
  const key = form.get("step");
  if (!isOnboardingKey(key)) redirect("/willkommen");
  await markDone(auth.organization.id, key);
  if (key === "done") {
    await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "onboarding.done" });
    revalidatePath("/heute");
    redirect("/heute");
  }
  goNext(key);
}
