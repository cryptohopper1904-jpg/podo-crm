"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { memberships, organizations, services, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { requireAuth } from "@/lib/auth/session";
import { generateTotpSecret, matchTotpStep } from "@/lib/auth/totp";
import { parseMoney } from "@/lib/format";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { seatCounts, seatProblem } from "@/lib/plans";
import { usedSeats } from "@/server/billing";

export type SettingsState = { error?: string; ok?: string; secret?: string } | undefined;
const opt = z.string().trim().max(300).optional().transform((v) => v || null);

export async function savePracticeAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({
      name: z.string().trim().min(2),
      legalName: opt, street: opt, zip: opt, city: opt, phone: opt, email: opt, taxNumber: opt, vatId: opt, iban: opt,
      state: z.string().length(2),
      smallBusiness: z.string().optional(),
      materialCost: z.string().optional(),
      openingFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      openingTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const { smallBusiness, materialCost, openingFrom, openingTo, ...rest } = d.data;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  await db
    .update(organizations)
    .set({
      ...rest,
      smallBusiness: smallBusiness === "on",
      settings: { ...org.settings, materialCostCents: parseMoney(materialCost ?? "") ?? 350, opening: { from: openingFrom ?? "08:00", to: openingTo ?? "18:00" } },
    })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.practice" });
  revalidatePath("/einstellungen/praxis");
  return { ok: "Gespeichert." };
}

export async function inviteMemberAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("users.manage");
  const d = z
    .object({
      name: z.string().trim().min(2, "Name fehlt"),
      email: z.string().trim().toLowerCase().email("E-Mail ungültig"),
      role: z.enum(["owner", "therapist", "reception", "trainee", "accountant"]),
      password: z.string(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const org = auth.organization.id;
  // Plätze laut Tarif (Vorabprüfung; verbindlich unten in der gesperrten Transaktion)
  const seatPre = seatProblem(auth.billing, await usedSeats(org), d.data.role);
  if (seatPre) return { error: seatPre };
  let [user] = await db.select().from(users).where(eq(users.email, d.data.email));
  if (!user) {
    const p = passwordProblem(d.data.password);
    if (p) return { error: `Startpasswort: ${p}` };
    [user] = await db.insert(users).values({ email: d.data.email, name: d.data.name, passwordHash: await hashPassword(d.data.password) }).returning();
  }
  const [exists] = await db.select().from(memberships).where(and(eq(memberships.organizationId, org), eq(memberships.userId, user.id)));
  if (exists) return { error: "Diese Person ist bereits im Team." };
  const seatErr = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${org}`}))`);
    const problem = seatProblem(auth.billing, await usedSeats(org, tx), d.data.role);
    if (problem) return problem;
    await tx.insert(memberships).values({ organizationId: org, userId: user.id, role: d.data.role });
    return null;
  });
  if (seatErr) return { error: seatErr };
  await audit({ organizationId: org, userId: auth.user.id, action: "member.add", entity: "user", entityId: user.id, meta: { role: d.data.role } });
  revalidatePath("/einstellungen/team");
  return { ok: `${d.data.name} wurde hinzugefügt. Bitte das Startpasswort sicher übergeben und beim ersten Login ändern lassen.` };
}

export async function updateMemberAction(form: FormData) {
  const auth = await requireAuth("users.manage");
  const org = auth.organization.id;
  const id = z.string().uuid().parse(form.get("id"));
  const role = z.enum(["owner", "therapist", "reception", "trainee", "accountant"]).optional().parse(form.get("role") || undefined);
  const active = form.get("active");
  const [m] = await db.select().from(memberships).where(and(eq(memberships.organizationId, org), eq(memberships.id, id)));
  if (!m || m.userId === auth.user.id) return; // eigene Rolle nicht ändern (Aussperren verhindern)
  const nextRole = role ?? m.role;
  const nextActive = active !== null ? active === "1" : m.active;
  // Belegt die Person danach (neu) einen Platz? Dann Tarif-Plätze prüfen
  const takesSeat = nextActive && seatCounts(nextRole) && !(m.active && seatCounts(m.role));
  const blocked = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${org}`}))`);
    if (takesSeat && seatProblem(auth.billing, await usedSeats(org, tx), nextRole)) return true;
    await tx
      .update(memberships)
      .set({ ...(role ? { role } : {}), ...(active !== null ? { active: active === "1" } : {}) })
      .where(and(eq(memberships.organizationId, org), eq(memberships.id, id)));
    return false;
  });
  if (blocked) redirect("/einstellungen/team?plaetze=voll");
  await audit({ organizationId: org, userId: auth.user.id, action: "member.update", entity: "membership", entityId: id, meta: { role, active } });
  revalidatePath("/einstellungen/team");
}

export async function saveServiceAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const d = z
    .object({
      id: z.string().uuid().optional(),
      code: z.string().trim().min(1).max(10).toUpperCase(),
      name: z.string().trim().min(2).max(200),
      price: z.string(),
      vatRate: z.coerce.number().refine((v) => [0, 7, 19].includes(v)),
      durationMin: z.coerce.number().int().min(0).max(480),
      category: z.string().default("treatment"),
      gkvPosition: opt,
      active: z.string().optional(),
    })
    .safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => v !== "")));
  if (!d.success) return { error: d.success === false ? d.error.issues[0]?.message : undefined };
  const priceCents = parseMoney(d.data.price);
  if (priceCents === null) return { error: "Preis ungültig" };
  const values = {
    code: d.data.code,
    name: d.data.name,
    priceCents,
    vatRate: d.data.vatRate,
    durationMin: d.data.durationMin,
    category: d.data.category,
    gkvPosition: d.data.gkvPosition,
    requiresTherapeuticPurpose: d.data.vatRate === 0,
    active: d.data.id ? d.data.active === "on" : true,
  };
  try {
    await withOrg(org, (tx) =>
      d.data.id
        ? tx.update(services).set(values).where(and(eq(services.organizationId, org), eq(services.id, d.data.id)))
        : tx.insert(services).values({ ...values, organizationId: org }),
    );
  } catch {
    return { error: `Das Kürzel ${d.data.code} gibt es schon.` };
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "service.save", meta: { code: d.data.code } });
  revalidatePath("/einstellungen/leistungen");
  return { ok: "Gespeichert." };
}

export async function startTotpAction(): Promise<SettingsState> {
  const auth = await requireAuth();
  if (auth.user.totpEnabled) return { error: "2FA ist bereits aktiv." };
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(secret), totpEnabled: false }).where(eq(users.id, auth.user.id));
  return { secret };
}

export async function confirmTotpAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth();
  const [u] = await db.select().from(users).where(eq(users.id, auth.user.id));
  if (!u.totpSecretEnc) return { error: "Bitte zuerst einrichten." };
  const step = matchTotpStep(decryptSecret(u.totpSecretEnc), String(form.get("code") ?? ""));
  if (step === null) return { error: "Code stimmt nicht." };
  await db.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, auth.user.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "2fa.enabled" });
  revalidatePath("/einstellungen/sicherheit");
  return { ok: "Zwei-Faktor-Anmeldung ist aktiv." };
}

export async function changePasswordAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth();
  const [u] = await db.select().from(users).where(eq(users.id, auth.user.id));
  if (!(await verifyPassword(u.passwordHash, String(form.get("current") ?? "")))) return { error: "Aktuelles Passwort stimmt nicht." };
  const next = String(form.get("next") ?? "");
  const p = passwordProblem(next);
  if (p) return { error: p };
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, auth.user.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "password.changed" });
  return { ok: "Passwort geändert." };
}
