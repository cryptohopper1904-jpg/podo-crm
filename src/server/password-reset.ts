import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { passwordResets, sessions, users } from "@/db/schema";
import { MailNotConfiguredError, type MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { log } from "@/lib/log";
import { createRateLimiter } from "@/lib/rate-limit";
import { platformMailPort } from "./mail";

/**
 * „Passwort vergessen“:
 * - Antwort immer gleich (keine Konten-Erkennung), Drosselung je IP und je E-Mail-Adresse.
 * - Token: 32 Zufallsbytes, gespeichert wird nur sha256; 30 Minuten gültig, einmalig. Ein neues Token
 *   entwertet alle offenen Tokens der Person.
 * - Neues Passwort: Passwort-Richtlinie, alle Sitzungen beendet, Kontosperre zurückgesetzt, Audit „password.reset“.
 *   2FA bleibt unverändert – beim nächsten Login wird der Code wie immer verlangt.
 * - Versand über den Plattform-SMTP (SMTP_URL). Ohne Versandweg in Produktion: Warnung im Log (ohne Token).
 */
export const RESET_TTL_MS = 30 * 60_000;
export const RESET_NEUTRAL_MESSAGE =
  "Wenn ein Konto mit dieser E-Mail-Adresse existiert, haben wir eine E-Mail mit einem Link zum Zurücksetzen geschickt. Der Link ist 30 Minuten gültig.";
export const RESET_INVALID = "Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte einen neuen Link anfordern.";

const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });
const emailLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });
/** nur für Tests */
export const _resetPasswordResetLimits = () => {
  ipLimiter.reset();
  emailLimiter.reset();
};

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const normalizeEmail = (v: string) => v.trim().toLowerCase().slice(0, 254);

export function resetLink(token: string, publicUrl = process.env.PUBLIC_URL): string {
  const base = (publicUrl || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/login/passwort-neu?token=${encodeURIComponent(token)}`;
}

type Deps = { port?: MailPort; now?: Date };

/** Legt ein neues Token an (alte offene Tokens der Person werden entwertet) und gibt es zurück. */
async function issueToken(userId: string, ip: string | null, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await tx.insert(passwordResets).values({ userId, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + RESET_TTL_MS), createdIp: ip?.slice(0, 64) ?? null });
  });
  return token;
}

async function deliver(to: string, token: string, port?: MailPort, opts: { byPlatform?: boolean } = {}): Promise<boolean> {
  let mail: MailPort;
  try {
    mail = port ?? platformMailPort();
  } catch (e) {
    if (e instanceof MailNotConfiguredError) {
      // nie das Token oder die Adresse loggen
      log.warn("password_reset.no_mail_transport", { hint: "SMTP_URL/SMTP_FROM setzen, sonst kommen keine Links zum Zurücksetzen an" });
      return false;
    }
    throw e;
  }
  try {
    await mail.send({
      to,
      subject: "Passwort zurücksetzen – PodoHero",
      text: [
        "Hallo,",
        "",
        opts.byPlatform
          ? "der Betreiber von PodoHero hat für dein Konto einen Link zum Zurücksetzen des Passworts angefordert (z. B. auf deine Bitte hin)."
          : "für dein PodoHero-Konto wurde ein neues Passwort angefordert.",
        "Mit diesem Link legst du ein neues Passwort fest (30 Minuten gültig, nur einmal verwendbar):",
        "",
        resetLink(token),
        "",
        "Wenn du das nicht warst, ignoriere diese E-Mail – dein Passwort bleibt unverändert.",
        "Die Zwei-Faktor-Anmeldung bleibt aktiv.",
      ].join("\n"),
    });
    return true;
  } catch (e) {
    log.warn("password_reset.mail_failed", { error: e });
    return false;
  }
}

/**
 * Anfrage „Passwort vergessen“. Gibt IMMER dieselbe Meldung zurück. Der Versand läuft über `send` (vom Aufrufer
 * nach der Antwort ausgeführt, z. B. per after()), damit die Antwortzeit nicht verrät, ob ein Konto existiert.
 */
export async function requestPasswordReset(rawEmail: string, meta: { ip: string | null; key: string }, deps: Deps = {}): Promise<{ message: string; send: (() => Promise<boolean>) | null }> {
  const email = normalizeEmail(rawEmail);
  const now = deps.now ?? new Date();
  const neutral = { message: RESET_NEUTRAL_MESSAGE, send: null };
  // beide Zähler immer erhöhen (gleiches Verhalten mit und ohne Konto)
  const ipLimited = ipLimiter.limited(meta.key);
  const emailLimited = emailLimiter.limited(`e:${sha256(email)}`);
  if (ipLimited || emailLimited || !email.includes("@")) return neutral;
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) return neutral;
  const token = await issueToken(user.id, meta.ip, now);
  await audit({ userId: user.id, action: "password.reset_requested" }).catch(() => undefined);
  return { message: RESET_NEUTRAL_MESSAGE, send: () => deliver(user.email, token, deps.port) };
}

/** Plattform-Admin (mit 2FA) schickt einer Person einen Link – das Passwort sieht dabei niemand. */
export async function platformSendPasswordReset(admin: { id: string; isPlatformAdmin: boolean; totpEnabled: boolean }, userId: string, deps: Deps = {}): Promise<{ sent: boolean }> {
  if (!admin.isPlatformAdmin || !admin.totpEnabled) throw new Error("Nur Plattform-Admins mit aktiver Zwei-Faktor-Anmeldung.");
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("Konto nicht gefunden.");
  const token = await issueToken(user.id, null, deps.now ?? new Date());
  const sent = await deliver(user.email, token, deps.port, { byPlatform: true });
  await audit({ userId: admin.id, action: "platform.password_reset_sent", entity: "user", entityId: user.id, meta: { sent } });
  return { sent };
}

/** Ist das Token (noch) gültig? Für die Anzeige von /login/passwort-neu. */
export async function resetTokenValid(token: string, now = new Date()): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const [r] = await db
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
    .limit(1);
  return !!r;
}

/** Neues Passwort setzen: Token einmalig verbrauchen, Passwort ändern, ALLE Sitzungen beenden, Sperre zurücksetzen. */
export async function resetPassword(token: string, newPassword: string, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };
  if (!token || token.length > 200) return { ok: false, error: RESET_INVALID };
  const passwordHash = await hashPassword(newPassword);
  const userId = await db.transaction(async (tx) => {
    // atomar verbrauchen: parallele Anfragen mit demselben Token – nur eine gewinnt
    const [r] = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
      .returning({ userId: passwordResets.userId });
    if (!r) return null;
    await tx.update(users).set({ passwordHash, failedLogins: 0, lockedUntil: null }).where(eq(users.id, r.userId));
    await tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, r.userId), isNull(passwordResets.usedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, r.userId));
    return r.userId;
  });
  if (!userId) return { ok: false, error: RESET_INVALID };
  await audit({ userId, action: "password.reset" });
  return { ok: true };
}
