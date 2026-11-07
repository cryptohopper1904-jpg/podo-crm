"use server";

import { redirect } from "next/navigation";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { locations, memberships, organizations, sessions, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession, getSession, markSessionVerified } from "@/lib/auth/session";
import { matchTotpStep } from "@/lib/auth/totp";
import { decryptSecret } from "@/lib/secrets";
import { seedOrganizationDefaults } from "@/lib/org-defaults";

export type FormState = { error?: string; ok?: string } | undefined;

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const generic = "E-Mail oder Passwort ist falsch.";
  if (!user) {
    await hashPassword(password); // gleiche Laufzeit, kein Hinweis auf existierende Konten
    return { error: generic };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { error: "Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen." };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    // atomar hochzählen (keine Race Condition bei parallelen Versuchen)
    await db
      .update(users)
      .set({
        failedLogins: sql`case when ${users.failedLogins} + 1 >= ${LOCK_AFTER} then 0 else ${users.failedLogins} + 1 end`,
        lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${LOCK_AFTER} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, user.id));
    await audit({ userId: user.id, action: "login.failed" });
    return { error: generic };
  }
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.active, true)))
    .limit(1);
  if (!m) return { error: "Für dieses Konto ist keine Praxis freigeschaltet." };
  await db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(user.id, m.organizationId, !user.totpEnabled);
  await audit({ organizationId: m.organizationId, userId: user.id, action: "login.success" });
  redirect(user.totpEnabled ? "/login/2fa" : "/heute");
}

const MAX_TOTP_FAILURES = 5;

export async function verifyTotpAction(_: FormState, form: FormData): Promise<FormState> {
  const row = await getSession();
  if (!row) redirect("/login");
  if (row.session.verified) redirect("/heute");
  const code = String(form.get("code") ?? "");
  const secret = row.user.totpSecretEnc ? decryptSecret(row.user.totpSecretEnc) : null;
  const step = secret ? matchTotpStep(secret, code) : null;
  // Replay-Schutz: derselbe (oder ältere) Zeitschritt wird nicht zweimal akzeptiert
  if (step === null || (row.user.totpLastStep !== null && step <= row.user.totpLastStep)) {
    const [s] = await db
      .update(sessions)
      .set({ totpFailures: sql`${sessions.totpFailures} + 1` })
      .where(eq(sessions.id, row.session.id))
      .returning({ n: sessions.totpFailures });
    await audit({ userId: row.user.id, action: "login.2fa_failed" });
    if ((s?.n ?? MAX_TOTP_FAILURES) >= MAX_TOTP_FAILURES) {
      // Sitzung verwerfen und Konto kurz sperren
      await db.update(users).set({ lockedUntil: sql`now() + make_interval(mins => ${LOCK_MINUTES})` }).where(eq(users.id, row.user.id));
      await destroySession();
      redirect("/login");
    }
    return { error: "Der Code stimmt nicht. Bitte den aktuellen Code aus der Authenticator-App eingeben." };
  }
  await db.update(users).set({ totpLastStep: step }).where(eq(users.id, row.user.id));
  await markSessionVerified();
  redirect("/heute");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

const setupSchema = z.object({
  practiceName: z.string().trim().min(2, "Bitte den Praxisnamen angeben."),
  name: z.string().trim().min(2, "Bitte deinen Namen angeben."),
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail angeben."),
  password: z.string(),
  state: z.string().length(2).default("BB"),
  privacy: z.literal("on", { message: "Bitte die AVV/Datenschutzhinweise bestätigen." }),
});

/** Registrierung einer neuen Praxis. Die erste Praxis ist immer erlaubt, weitere nur mit ALLOW_SIGNUP=true. */
export async function setupAction(_: FormState, form: FormData): Promise<FormState> {
  const parsed = setupSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const pwProblem = passwordProblem(d.password);
  if (pwProblem) return { error: pwProblem };

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, d.email)).limit(1);
  if (existing) return { error: "Für diese E-Mail gibt es bereits ein Konto." };

  const slugBase = d.practiceName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "praxis";
  const slug = `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
  const passwordHash = await hashPassword(d.password);

  const result = await db.transaction(async (tx) => {
    // Erstinstallation serialisieren: nur genau eine erste Praxis/ein Plattform-Admin
    await tx.execute(sql`select pg_advisory_xact_lock(4711001)`);
    const [{ n }] = await tx.select({ n: count() }).from(users);
    if (n > 0 && process.env.ALLOW_SIGNUP !== "true") return null;
    const [org] = await tx.insert(organizations).values({ name: d.practiceName, slug, state: d.state }).returning();
    const [user] = await tx
      .insert(users)
      .values({ email: d.email, name: d.name, passwordHash, isPlatformAdmin: n === 0 })
      .returning();
    await tx.insert(memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
    await tx.insert(locations).values({ organizationId: org.id, name: "Hauptpraxis" });
    await seedOrganizationDefaults(tx, org.id);
    return { userId: user.id, orgId: org.id };
  });
  if (!result) return { error: "Neue Registrierungen sind auf diesem Server deaktiviert." };
  const { userId, orgId } = result;
  await createSession(userId, orgId, true);
  await audit({ organizationId: orgId, userId, action: "organization.created" });
  redirect("/heute");
}

/** Wechselt die aktive Praxis (für Nutzer mit mehreren Mitgliedschaften). */
export async function switchOrganizationAction(form: FormData) {
  const row = await getSession();
  if (!row || !row.session.verified) redirect("/login");
  const orgId = String(form.get("organizationId") ?? "");
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, row.user.id), eq(memberships.organizationId, orgId), eq(memberships.active, true)))
    .limit(1);
  if (m) {
    await db.update(sessions).set({ organizationId: orgId }).where(eq(sessions.id, row.session.id));
    await audit({ organizationId: orgId, userId: row.user.id, action: "organization.switched" });
  }
  redirect("/heute");
}
