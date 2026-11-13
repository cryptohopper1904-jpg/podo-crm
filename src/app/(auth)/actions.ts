"use server";

import { redirect } from "next/navigation";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { locations, memberships, organizations, sessions, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession, getSession, markSessionVerified, requestMeta, revokeUserSessions, rotateSession } from "@/lib/auth/session";
import { legalAcceptance } from "@/lib/legal";
import { PLANS, TRIAL_DAYS } from "@/lib/plans";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { generateTotpSecret, matchTotpStep } from "@/lib/auth/totp";
import { TWO_FACTOR_SETUP_PATH, twoFactorRequired } from "@/lib/auth/two-factor";
import type { Role } from "@/lib/auth/permissions";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { seedOrganizationDefaults } from "@/lib/org-defaults";
import { isDemoPractice } from "@/lib/demo-practice";
import { PLATFORM_TARGET } from "@/lib/org-switcher";
import { PROMO_INVALID } from "@/lib/promo-codes";
import { lookupPromoCode, PromoCodeError, promoFailLimiter, redeemPromoCodeTx } from "@/server/promo-codes";

export type FormState = { error?: string; ok?: string } | undefined;

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

/** Gegen Password-Spraying über viele Konten: Anmeldeversuche je Anschluss begrenzen (zusätzlich zur Kontosperre). */
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30 });

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  if (loginLimiter.limited(clientKey(await requestMeta()))) {
    return { error: "Zu viele Anmeldeversuche von diesem Anschluss. Bitte in 15 Minuten erneut versuchen." };
  }
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const generic = "Anmeldung nicht möglich: E-Mail oder Passwort falsch, oder Konto nach mehreren Fehlversuchen kurz gesperrt.";
  if (!user) {
    await hashPassword(password); // gleiche Laufzeit, kein Hinweis auf existierende Konten
    return { error: generic };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await hashPassword(password); // gleiche Laufzeit
    return { error: generic }; // kein Hinweis, dass das Konto existiert
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
  const all = await db
    .select({ organizationId: memberships.organizationId, role: memberships.role, settings: organizations.settings })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.active, true)))
    .orderBy(memberships.createdAt);
  // Plattform-Admins starten nie in einer Demo-Praxis (Bootstrap), sondern in der Plattform-Konsole –
  // die Demo-Praxis öffnen sie über „Demo-Praxis öffnen“ bzw. den Praxis-Wechsel.
  const m = user.isPlatformAdmin ? all.find((x) => !isDemoPractice(x.settings)) : all[0];
  // Plattform-Admin ohne Praxis (z. B. per BOOTSTRAP_ADMIN_* angelegt): Sitzung ohne Praxis – nur Plattform-Konsole
  // (die ihrerseits aktive 2FA verlangt). Ohne 2FA geht es direkt zur Einrichtung der 2FA.
  if (!m && !user.isPlatformAdmin) return { error: generic };
  await db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(user.id, m?.organizationId ?? null, !user.totpEnabled);
  await audit({ organizationId: m?.organizationId ?? null, userId: user.id, action: "login.success", meta: m ? undefined : { platformOnly: true } });
  if (user.totpEnabled) redirect("/login/2fa");
  // Pflicht-2FA (Inhaber:in, Plattform-Admin, ggf. alle Rollen der Praxis): Anmeldung erlaubt, aber erst nach
  // Einrichtung Zugriff auf die Praxis (Gesamt-Review H1, src/lib/auth/two-factor.ts)
  const required = twoFactorRequired({ role: (m?.role as Role | undefined) ?? null, isPlatformAdmin: user.isPlatformAdmin, orgSettings: m?.settings });
  if (required) await audit({ organizationId: m?.organizationId ?? null, userId: user.id, action: "2fa.setup_required" });
  redirect(required ? TWO_FACTOR_SETUP_PATH : "/heute");
}

/** Startseite nach der Anmeldung: Praxis-Sitzung → /heute, Plattform-Sitzung ohne Praxis → /plattform. */
function homeFor(session: { organizationId: string | null }) {
  return session.organizationId ? "/heute" : "/plattform";
}

const MAX_TOTP_FAILURES = 5;

export async function verifyTotpAction(_: FormState, form: FormData): Promise<FormState> {
  const row = await getSession();
  if (!row) redirect("/login");
  if (row.session.verified) redirect(homeFor(row.session));
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
      // Konto kurz sperren und ALLE Sitzungen der Person beenden: wer hier scheitert, kannte das Passwort.
      // (Passwort-Fehlversuche sperren nur neue Anmeldungen – sonst könnte jeder die echte Person ausloggen.)
      await db.update(users).set({ lockedUntil: sql`now() + make_interval(mins => ${LOCK_MINUTES})` }).where(eq(users.id, row.user.id));
      await revokeUserSessions(row.user.id);
      await audit({ userId: row.user.id, action: "login.2fa_locked" });
      await destroySession();
      redirect("/login");
    }
    return { error: "Der Code stimmt nicht. Bitte den aktuellen Code aus der Authenticator-App eingeben." };
  }
  // Atomar: parallele Anfragen mit demselben Code dürfen nicht beide durchkommen
  const [claimed] = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, row.user.id), sql`(${users.totpLastStep} is null or ${users.totpLastStep} < ${step})`))
    .returning({ id: users.id });
  if (!claimed) return { error: "Dieser Code wurde bereits verwendet. Bitte den nächsten Code abwarten." };
  await markSessionVerified();
  redirect(homeFor(row.session));
}

/**
 * 2FA-Einrichtung OHNE Praxis-Kontext (/login/2fa-einrichten) – für Plattform-Admins ohne Mitgliedschaft,
 * die die Plattform-Konsole erst mit aktiver 2FA öffnen dürfen. Nur mit bestätigter Sitzung und solange 2FA noch aus ist.
 */
export async function startOwnTotpAction(): Promise<{ secret?: string; error?: string }> {
  const row = await getSession();
  if (!row || !row.session.verified) redirect("/login");
  if (row.user.totpEnabled) return { error: "2FA ist bereits aktiv." };
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(secret), totpEnabled: false }).where(and(eq(users.id, row.user.id), eq(users.totpEnabled, false)));
  return { secret };
}

export async function confirmOwnTotpAction(_: FormState, form: FormData): Promise<FormState> {
  const row = await getSession();
  if (!row || !row.session.verified) redirect("/login");
  if (row.user.totpEnabled) redirect(homeFor(row.session));
  const [u] = await db.select().from(users).where(eq(users.id, row.user.id));
  if (!u?.totpSecretEnc) return { error: "Bitte zuerst einrichten." };
  const step = matchTotpStep(decryptSecret(u.totpSecretEnc), String(form.get("code") ?? ""));
  if (step === null) return { error: "Code stimmt nicht." };
  await db.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, row.user.id));
  await audit({ organizationId: row.session.organizationId, userId: row.user.id, action: "2fa.enabled" });
  // neue Sitzung (Session-Fixation), Bestätigungs-Status bleibt
  await markSessionVerified();
  redirect(homeFor(row.session));
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
  setupToken: z.string().optional(),
  agb: z.string().optional(),
  avv: z.string().optional(),
  /** Aktionscode (optional, z. B. aus /einrichtung?code=…): längere Testphase */
  code: z.string().max(64).optional(),
});

/** Registrierungen je IP drosseln (SaaS-Modus): max. 5 pro Stunde */
const signupLimiter = createRateLimiter({ windowMs: 3600_000, max: 5 });

/** Registrierung einer neuen Praxis. Die erste Praxis ist immer erlaubt, weitere nur mit ALLOW_SIGNUP=true. */
export async function setupAction(_: FormState, form: FormData): Promise<FormState> {
  const parsed = setupSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const legalOk = d.agb === "on" && d.avv === "on";
  if (signupLimiter.limited(clientKey(await requestMeta()))) {
    return { error: "Zu viele Registrierungen von diesem Anschluss. Bitte in einer Stunde erneut versuchen." };
  }
  const pwProblem = passwordProblem(d.password);
  if (pwProblem) return { error: pwProblem };
  // Aktionscode: vorab prüfen (allgemeine Meldung, Fehlversuche je Anschluss gedrosselt); eingelöst wird atomar unten
  const promoInput = d.code?.trim() ? d.code : null;
  const promoKey = `signup:${clientKey(await requestMeta())}`;
  if (promoInput) {
    if (promoFailLimiter.exceeded(promoKey)) return { error: `${PROMO_INVALID} Zu viele Versuche – bitte später erneut versuchen.` };
    if (!(await lookupPromoCode(promoInput))) {
      promoFailLimiter.limited(promoKey);
      return { error: `${PROMO_INVALID} Ohne Code bitte das Feld „Aktionscode“ leeren (dann 30 Tage Testphase).` };
    }
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, d.email)).limit(1);
  if (existing) return { error: "Mit diesen Angaben ist keine Registrierung möglich. Bereits registriert? Bitte anmelden oder das Passwort zurücksetzen lassen." };

  const slugBase = d.practiceName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "praxis";
  const slug = `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
  const passwordHash = await hashPassword(d.password);

  const result = await db
    .transaction(async (tx) => {
    // Erstinstallation serialisieren: nur genau eine erste Praxis/ein Plattform-Admin
    await tx.execute(sql`select pg_advisory_xact_lock(4711001)`);
    const [{ n }] = await tx.select({ n: count() }).from(users);
    if (n > 0 && process.env.ALLOW_SIGNUP !== "true") return null;
    // Ersteinrichtung nur mit Einmal-Token aus der Server-Konfiguration (sonst könnte jeder zuerst kommen)
    // In Produktion ist SETUP_TOKEN Pflicht (fail-closed); lokal in der Entwicklung optional.
    const setupToken = process.env.SETUP_TOKEN;
    if (n === 0 && (setupToken ? d.setupToken !== setupToken : process.env.NODE_ENV === "production")) return "token" as const;
    // Selbstregistrierung (SaaS): AGB + AVV (versioniert) sind Pflicht
    if (n > 0 && !legalOk) return "legal" as const;
    // Erste Praxis = Betreiber-Praxis („intern“, ohne Abo); jede weitere startet mit 30 Tagen Testphase
    const [org] = await tx
      .insert(organizations)
      .values({
        name: d.practiceName,
        slug,
        state: d.state,
        plan: n === 0 ? "internal" : "trial",
        subscriptionStatus: n === 0 ? "active" : "trialing",
        trialEndsAt: n === 0 ? null : new Date(Date.now() + TRIAL_DAYS * 86_400_000),
        seats: n === 0 ? 1 : PLANS.trial.includedSeats,
      })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({ email: d.email, name: d.name, passwordHash, isPlatformAdmin: n === 0 })
      .returning();
    if (n > 0) {
      await tx.update(organizations).set({ settings: { legalAcceptance: legalAcceptance(user.id) } }).where(eq(organizations.id, org.id));
    }
    await tx.insert(memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
    await tx.insert(locations).values({ organizationId: org.id, name: "Hauptpraxis" });
    await seedOrganizationDefaults(tx, org.id);
    // Aktionscode (nur bei Selbstregistrierung): Testphase = max(30 Tage, Code-Tage); Fehler rollt alles zurück
    const promo = n > 0 && promoInput ? await redeemPromoCodeTx(tx, { input: promoInput, organizationId: org.id, userId: user.id, via: "signup" }) : null;
    return { userId: user.id, orgId: org.id, legal: n > 0, promo: promo?.code ?? null };
  })
    .catch((e: unknown) => {
      if (e instanceof PromoCodeError) return "promo" as const;
      throw e;
    });
  if (result === "promo") {
    promoFailLimiter.limited(promoKey);
    return { error: PROMO_INVALID };
  }
  if (!result) return { error: "Neue Registrierungen sind auf diesem Server deaktiviert." };
  if (result === "token") return { error: "Einrichtungs-Code ist falsch (siehe SETUP_TOKEN in der Server-Konfiguration)." };
  if (result === "legal") return { error: "Bitte AGB und Auftragsverarbeitungsvertrag (AVV) akzeptieren." };
  const { userId, orgId, legal, promo } = result;
  await createSession(userId, orgId, true);
  await audit({ organizationId: orgId, userId, action: "organization.created", meta: legal ? { legal: legalAcceptance(userId), ...(promo ? { promo } : {}) } : undefined });
  redirect("/willkommen");
}

/**
 * Wechselt die aktive Praxis (für Nutzer mit mehreren Mitgliedschaften). Plattform-Admins mit 2FA können mit
 * organizationId = "plattform" in eine Sitzung ohne Praxis (nur Plattform-Konsole) wechseln.
 */
export async function switchOrganizationAction(form: FormData) {
  const row = await getSession();
  if (!row || !row.session.verified) redirect("/login");
  const orgId = String(form.get("organizationId") ?? "");
  if (orgId === PLATFORM_TARGET) {
    if (!row.user.isPlatformAdmin || !row.user.totpEnabled) redirect("/heute");
    if (row.session.organizationId) {
      if (!(await rotateSession(row.session.id, row.user.id, null))) redirect("/login");
      await audit({ userId: row.user.id, action: "organization.switched", meta: { to: "platform", from: row.session.organizationId } });
    }
    redirect("/plattform");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) redirect("/heute");
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, row.user.id), eq(memberships.organizationId, orgId), eq(memberships.active, true)))
    .limit(1);
  if (m) {
    // Neues Token je Praxiswechsel (altes Token danach wertlos)
    if (!(await rotateSession(row.session.id, row.user.id, orgId))) redirect("/login");
    await audit({ organizationId: orgId, userId: row.user.id, action: "organization.switched" });
  }
  redirect("/heute");
}
