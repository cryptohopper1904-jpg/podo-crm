"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { confirmsPracticeName, isWithinGrace } from "@/lib/org-deletion";

export type DataState = { error?: string; ok?: string } | undefined;

async function requireOwner() {
  const auth = await requireAuth("settings.manage");
  if (auth.role !== "owner") throw new Error("Nur Inhaber:innen können die Praxis kündigen.");
  return auth;
}

/** Schritt 2 der Kündigung: Praxisname eingetippt + Export-Hinweis bestätigt → Löschung beantragen. */
export async function requestDeletionAction(_: DataState, form: FormData): Promise<DataState> {
  let auth;
  try {
    auth = await requireOwner();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const name = String(form.get("confirmName") ?? "");
  if (form.get("acknowledge") !== "on") return { error: "Bitte bestätigen Sie, dass Sie einen Export gesichert haben und Ihre Aufbewahrungspflichten kennen." };
  if (!confirmsPracticeName(name, auth.organization.name)) return { error: "Der eingegebene Praxisname stimmt nicht überein." };
  // organizations hat keine RLS – Filter auf die eigene Praxis ist hier die Zugriffskontrolle
  const [row] = await db
    .update(organizations)
    .set({ deletionRequestedAt: new Date() })
    .where(and(eq(organizations.id, auth.organization.id), isNull(organizations.deletionRequestedAt)))
    .returning({ at: organizations.deletionRequestedAt });
  if (!row) return { error: "Die Löschung wurde bereits beantragt." };
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "org.deletion_requested", entity: "organization", entityId: auth.organization.id });
  revalidatePath("/einstellungen/daten");
  return { ok: "Kündigung und Löschung beantragt." };
}

/** Rücknahme innerhalb der Karenzzeit. */
export async function cancelDeletionAction(_: DataState, _form: FormData): Promise<DataState> {
  void _form;
  let auth;
  try {
    auth = await requireOwner();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const [org] = await db.select({ at: organizations.deletionRequestedAt }).from(organizations).where(eq(organizations.id, auth.organization.id));
  if (!org?.at) return { ok: "Es ist keine Löschung beantragt." };
  if (!isWithinGrace(org.at)) return { error: "Die Karenzzeit ist abgelaufen. Bitte wenden Sie sich an den Support." };
  await db.update(organizations).set({ deletionRequestedAt: null }).where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "org.deletion_cancelled", entity: "organization", entityId: auth.organization.id });
  revalidatePath("/einstellungen/daten");
  return { ok: "Die Löschung wurde zurückgenommen. Ihre Praxis bleibt bestehen." };
}
